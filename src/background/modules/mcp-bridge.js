/**
 * MCP Bridge Module
 *
 * Enables communication between MCP server and the Chrome extension.
 * Uses the WebSocket relay (ws://localhost:7862) for MCP task traffic.
 *
 * The service worker can sleep at any time, dropping the WebSocket.
 * On wake, connectToRelay() reconnects and the relay delivers queued task
 * commands. Native host is still used for debug logging and legacy auth flows,
 * but not for MCP task transport.
 */


import * as toolHandlerModule from '../tool-handlers/index.js';
import {
  getRelaySocket, setRelaySocket,
  isRelayConnected,
  dispatchRelayResponse, dispatchProxyResponse, failAllPending,
} from './relay-client.js';

const NATIVE_HOST_NAME = 'com.hanzi_browse.oauth_host';
const WS_RELAY_URL_LOCAL = 'ws://localhost:7862';

// Managed relay URL — derived from the managed backend URL stored during pairing
let managedRelayUrl = null;

// Managed session → tab mapping. Each managed session owns a specific tab.
// This prevents managed tool execution from using the global active tab fallback.
const managedSessionTabs = new Map();

// Stop flag — when true, reject all incoming tool executions
let managedTaskStopped = false;

// Pending LLM responses — for proxying LLM calls through the relay
const pendingLLMRequests = new Map(); // requestId → { resolve, reject, timeout }

// Managed session credentials (set when pairing flow completes)
let managedSessionToken = null;
let managedBrowserSessionId = null;

/**
 * Set managed session credentials (called from extension UI after pairing).
 * On next relay connect, the extension will register with the session token
 * instead of the legacy role-based registration.
 */
export async function setManagedSession(sessionToken, browserSessionId, apiUrl) {
  managedSessionToken = sessionToken;
  managedBrowserSessionId = browserSessionId;
  managedTaskStopped = false; // Reset stop flag on new session

  // Derive relay URL from API URL
  // For HTTPS: use wss://relay.{domain} (port 443 via Caddy)
  // For HTTP: use ws://{hostname}:7862 (direct)
  if (apiUrl) {
    try {
      const url = new URL(apiUrl);
      if (url.protocol === 'https:') {
        // Production: relay runs behind Caddy on relay.{domain}
        const domain = url.hostname.replace(/^api\./, 'relay.');
        managedRelayUrl = `wss://${domain}`;
      } else {
        // Local dev: relay on same host, use port from URL (set by register response) or default 7862
        const relayPort = url.port || '7862';
        managedRelayUrl = `ws://${url.hostname}:${relayPort}`;
      }
    } catch {
      managedRelayUrl = null;
    }
  }

  // Don't capture the active tab at pairing time — it's likely the dashboard page.
  // Instead, a dedicated tab will be created lazily on first tool execution (in the execute_tool handler).

  // Store persistently
  const storageData = {
    managed_session_token: sessionToken,
    managed_browser_session_id: browserSessionId,
    managed_relay_url: managedRelayUrl,
  };
  // Clear any stale tab mapping — new tab will be created lazily on first tool execution
  if (browserSessionId) {
    const tabMap = (await chrome.storage.local.get('managed_session_tabs')).managed_session_tabs || {};
    delete tabMap[browserSessionId];
    storageData.managed_session_tabs = tabMap;
    managedSessionTabs.delete(browserSessionId);
  }
  await chrome.storage.local.set(storageData);

  // Reconnect to relay with the new credentials
  const sock = getRelaySocket();
  if (sock) {
    sock.close();
    setRelaySocket(null); // Clear reference so connectToRelay doesn't skip
  }
  connectToRelay();
}

/**
 * Clear managed session (disconnect from managed mode).
 */
export function clearManagedSession() {
  managedSessionToken = null;
  managedBrowserSessionId = null;
  managedRelayUrl = null;
  chrome.storage.local.remove([
    'managed_session_token', 'managed_browser_session_id',
    'managed_relay_url', 'managed_session_tabs',
  ]);
  managedSessionTabs.clear();
  // Close the managed relay connection and reconnect to local
  const sock2 = getRelaySocket();
  if (sock2) {
    sock2.close();
    setRelaySocket(null);
  }
  connectToRelay();
}

/**
 * Get current managed session info.
 * Reads from storage since service worker memory is volatile.
 */
export async function getManagedSessionInfo() {
  const stored = await chrome.storage.local.get(['managed_session_token', 'managed_browser_session_id']);
  return {
    isManaged: !!stored.managed_session_token,
    browserSessionId: stored.managed_browser_session_id || null,
  };
}
const WS_RECONNECT_DELAY_MS = 5000;

// Direct imports for credential handling (chrome.runtime.sendMessage cannot
// message the service worker from within itself — "Receiving end does not exist")
import { importCLICredentials } from './oauth-manager.js';
import { importCodexCredentials } from './codex-oauth-manager.js';
import { loadConfig } from './api.js';

// WebSocket reconnect timer (socket itself lives in relay-client.js)
let wsReconnectTimer = null;

// Active MCP sessions
const mcpSessions = new Map();
const pendingResponseOwners = new Map();

// Pending get_info requests (waiting for MCP server response)
// Map<requestId, { resolve: Function, reject: Function, timeout: NodeJS.Timeout }>
const pendingGetInfoRequests = new Map();
let getInfoRequestCounter = 0;

// Pending escalation requests (waiting for planning agent guidance)
// Map<requestId, { resolve: Function, timeout: NodeJS.Timeout }>
const pendingEscalateRequests = new Map();
let escalateRequestCounter = 0;

// Callbacks for MCP events
let onStartTask = null;
let onSendMessage = null;
let onStopTask = null;
let onScreenshot = null;

/**
 * Initialize MCP bridge with callbacks.
 * MCP task transport requires the WebSocket relay.
 */
export function initMcpBridge(callbacks) {
  onStartTask = callbacks.onStartTask;
  onSendMessage = callbacks.onSendMessage;
  onStopTask = callbacks.onStopTask;
  onScreenshot = callbacks.onScreenshot;

  console.log('[MCP Bridge] Initialized');

  // Try WebSocket relay first
  connectToRelay();

  // Keepalive alarm — wakes the service worker periodically to reconnect
  // relay WebSocket (which drops when the service worker sleeps).
  // The relay queues messages while we're offline, so reconnecting
  // delivers any pending start_task/send_message commands.
  try {
    chrome.alarms.create('ws-keepalive', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'ws-keepalive') {
        connectToRelay();
      }
    });
  } catch (e) {
    console.warn('[MCP Bridge] Alarms API unavailable:', e.message);
  }
}

/**
 * Connect to the WebSocket relay server.
 * On failure/disconnect, schedules reconnect.
 */
export function connectToRelay() {
  // Clear any pending reconnect
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  // Don't reconnect if already connected
  if (isRelayConnected()) {
    return;
  }

  // Load managed credentials from storage first, then connect.
  // Use callback form — promise-based chrome.storage.local.get() is not
  // available in all Chrome versions / startup contexts.
  chrome.storage.local.get(['managed_session_token', 'managed_browser_session_id', 'managed_relay_url'], (stored) => {
    if (stored && stored.managed_session_token) {
      managedSessionToken = stored.managed_session_token;
      managedBrowserSessionId = stored.managed_browser_session_id;
      managedRelayUrl = stored.managed_relay_url || null;
    }
    _doConnect();
  });
}

function _doConnect() {
  if (isRelayConnected()) return;

  try {
    // Use remote relay for managed mode, local relay for BYOM
    const relayUrl = (managedSessionToken && managedRelayUrl) ? managedRelayUrl : WS_RELAY_URL_LOCAL;
    console.log('[MCP Bridge] Connecting to WebSocket relay:', relayUrl);
    const ws = new WebSocket(relayUrl);
    setRelaySocket(ws);

    ws.onopen = () => {
      // Guard against stale callbacks after reconnect replaces the socket
      if (getRelaySocket() !== ws) return;
      console.log('[MCP Bridge] WebSocket connected');

      // Register with session token (managed) or role (BYOM legacy)
      if (managedSessionToken) {
        ws.send(JSON.stringify({
          type: 'register',
          role: 'extension',
          session_token: managedSessionToken,
        }));
        console.log('[MCP Bridge] Registered as managed session:', managedBrowserSessionId);
      } else {
        ws.send(JSON.stringify({ type: 'register', role: 'extension' }));
        console.log('[MCP Bridge] Registered as legacy extension');
      }
    };

    ws.onmessage = async (event) => {
      if (getRelaySocket() !== ws) return; // Stale socket guard
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'registered' || message.type === 'error') {
          if (message.type === 'error') {
            console.warn('[MCP Bridge] Relay error:', message.error);
            // Invalid session token means the session was deleted or expired.
            // Clear stale credentials so we stop retrying and fall back to local relay.
            if (message.error && String(message.error).includes('Invalid session token') && managedSessionToken) {
              console.warn('[MCP Bridge] Clearing invalid managed session — re-pair to reconnect');
              clearManagedSession();
            }
          }
          return;
        }

        // Respond to relay keepalive pings (keeps service worker alive)
        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          // Handle token rotation — relay periodically issues new session tokens.
          // Must update BOTH the persistent storage key (managed_session_token)
          // AND the in-memory variable (managedSessionToken) so reconnects use
          // the new token immediately. The storage write MUST complete before
          // the service worker can sleep, otherwise next wake loads the old token.
          if (message.new_session_token) {
            const previousToken = managedSessionToken;
            managedSessionToken = message.new_session_token;
            try {
              await chrome.storage.local.set({ managed_session_token: message.new_session_token });
              console.log('[MCP Bridge] Session token rotated and persisted');
            } catch (e) {
              // Revert in-memory to match what's actually persisted.
              // Otherwise next reconnect reads the old token from storage
              // but in-memory has the new (unpersisted) token — state diverges.
              managedSessionToken = previousToken;
              console.error('[MCP Bridge] Failed to persist rotated token, reverted in-memory:', e);
            }
          }
          return;
        }

        // Dispatch to relay-client pending request/proxy maps
        if (dispatchRelayResponse(message)) return;
        if (dispatchProxyResponse(message)) return;

        // Route through the same command handler as polling
        // Messages from MCP/CLI come in the same format as inbox commands
        // but with mcp_ prefix (e.g., mcp_start_task → start_task)
        const command = normalizeIncomingMessage(message);
        if (command) {
          handleMcpCommand(command);
        }
      } catch (e) {
        console.error('[MCP Bridge] WebSocket message parse error:', e);
      }
    };

    ws.onclose = () => {
      // Only handle if this is still the current socket
      if (getRelaySocket() !== ws) return;
      console.log('[MCP Bridge] WebSocket disconnected');

      // Fail any in-flight relay operations so callers don't hang forever
      failAllPending();
      setRelaySocket(null);

      // Schedule reconnect
      wsReconnectTimer = setTimeout(() => {
        connectToRelay();
      }, WS_RECONNECT_DELAY_MS);
    };

    ws.onerror = (_err) => {
      if (getRelaySocket() !== ws) return;
      console.log('[MCP Bridge] WebSocket error (relay may not be running)');
      // onclose will fire after this, handling fallback
    };
  } catch (e) {
    console.log('[MCP Bridge] WebSocket connection failed:', e.message);

    // Schedule reconnect
    wsReconnectTimer = setTimeout(() => {
      connectToRelay();
    }, WS_RECONNECT_DELAY_MS);
  }
}

/**
 * Normalize incoming WebSocket messages to the command format
 * expected by handleMcpCommand().
 *
 * Messages from MCP/CLI arrive with mcp_ prefix (e.g., mcp_start_task).
 * The handleMcpCommand() expects unprefixed types (e.g., start_task).
 */
function normalizeIncomingMessage(message) {
  const { type, ...rest } = message;

  // Map from MCP server message types to bridge command types
  const typeMap = {
    'mcp_start_task': 'start_task',
    'mcp_send_message': 'send_message',
    'mcp_stop_task': 'stop_task',
    'mcp_screenshot': 'screenshot',
    'mcp_get_info_response': 'get_info_response',
    'mcp_escalate_response': 'escalate_response',
    'mcp_save_config': 'save_config',
    'mcp_import_credentials': 'import_credentials',
    'mcp_execute_tool': 'execute_tool',
    'llm_request': 'llm_request',
  };

  const mappedType = typeMap[type];
  if (mappedType === undefined) {
    // Unknown type — try passing through as-is
    return { type, ...rest };
  }
  if (mappedType === null) {
    // Type should be skipped
    return null;
  }

  return { type: mappedType, ...rest };
}

/**
 * Check if WebSocket relay is connected
 */
export function stopManagedTask() {
  managedTaskStopped = true;
  // Clear tab mappings so next task creates fresh tabs
  managedSessionTabs.clear();
  chrome.storage.local.remove('managed_session_tabs').catch(() => {});
  // Hide overlay on all tabs
  chrome.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
      if (tab.id) try { chrome.tabs.sendMessage(tab.id, { type: 'HIDE_AGENT_INDICATORS' }); } catch { /* content script may not be injected */ }
    }
  });
  console.log('[MCP Bridge] Managed task stopped by user, tab mappings cleared');
}

function getSourceClientId(sessionId) {
  if (!sessionId) return null;
  return (
    mcpSessions.get(sessionId)?.sourceClientId ||
    pendingResponseOwners.get(sessionId) ||
    null
  );
}

function withSourceClientId(sessionId, message, { clearPending = false } = {}) {
  const sourceClientId = getSourceClientId(sessionId);
  if (sourceClientId) {
    message.sourceClientId = sourceClientId;
  }
  if (clearPending && sessionId) {
    pendingResponseOwners.delete(sessionId);
  }
  return message;
}

function ensureBridgeSession(sessionId, data = {}) {
  if (!sessionId) return null;
  const existing = mcpSessions.get(sessionId) || {};
  const next = {
    status: existing.status || 'running',
    context: existing.context,
    sourceClientId: existing.sourceClientId || null,
    ...existing,
    ...data,
  };
  mcpSessions.set(sessionId, next);
  return next;
}

/**
 * Handle an MCP command from the inbox
 */
/**
 * Proxy an LLM call through the relay to the managed backend.
 * Used by tools (e.g. find) that need LLM when running in managed mode.
 */
function callLLMViaRelay(params) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pendingLLMRequests.delete(requestId);
      reject(new Error('LLM request timed out (15s)'));
    }, 15000);

    pendingLLMRequests.set(requestId, { resolve, reject, timeout });

    sendToMcpRelay({
      type: 'llm_request',
      requestId,
      sessionId: managedBrowserSessionId,
      messages: params.messages,
      maxTokens: params.maxTokens || 800,
    });
  });
}

// eslint-disable-next-line complexity, sonarjs/cognitive-complexity
async function handleMcpCommand(command) {
  console.log('[MCP Bridge] Received command:', command.type, command.sessionId);

  // Handle LLM responses (from server-side LLM proxy)
  if (command.type === 'llm_response' && command.requestId) {
    const pending = pendingLLMRequests.get(command.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingLLMRequests.delete(command.requestId);
      if (command.error) {
        pending.reject(new Error(command.error));
      } else {
        pending.resolve({ content: command.content });
      }
    }
    return;
  }

  switch (command.type) {
    case 'start_task': {
      if (!onStartTask) break;

      // Idempotency guard: if this session is already starting or running,
      // ignore the duplicate start_task (e.g., from relay queue replay on reconnect).
      const existingSession = mcpSessions.get(command.sessionId);
      if (existingSession && (existingSession.status === 'starting' || existingSession.status === 'running')) {
        debugLog('Ignoring duplicate start_task for already-active session', command.sessionId);
        break;
      }

      debugLog('Adding session to mcpSessions', command.sessionId);
      mcpSessions.set(command.sessionId, {
        status: 'starting',
        context: command.context,
        sourceClientId: command.sourceClientId || null,
      });
      debugLog('mcpSessions now has', Array.from(mcpSessions.keys()));
      onStartTask(command.sessionId, command.task, command.url, command.context, command.licenseKey);
      break;
    }

    case 'send_message':
      // Allow send_message even if session is complete/error (for continuation)
      // The service worker will validate if the session actually exists
      if (onSendMessage) {
        ensureBridgeSession(command.sessionId, {
          sourceClientId: command.sourceClientId || getSourceClientId(command.sessionId),
        });
        onSendMessage(command.sessionId, command.message);
      }
      break;

    case 'stop_task':
      if (onStopTask) {
        ensureBridgeSession(command.sessionId, {
          sourceClientId: command.sourceClientId || getSourceClientId(command.sessionId),
        });
        const shouldRemove = command.remove === true;
        onStopTask(command.sessionId, shouldRemove);
        // Only delete from bridge if removing completely
        if (shouldRemove) {
          mcpSessions.delete(command.sessionId);
          pendingResponseOwners.delete(command.sessionId);
        }
      }
      break;

    case 'screenshot':
      if (onScreenshot) {
        ensureBridgeSession(command.sessionId, {
          sourceClientId: command.sourceClientId || getSourceClientId(command.sessionId),
        });
        if (command.sourceClientId) {
          pendingResponseOwners.set(command.sessionId, command.sourceClientId);
        }
        onScreenshot(command.sessionId);
      }
      break;

    case 'save_config': {
      // CLI setup wizard sends config updates (API keys, model defaults, etc.)
      const payload = command.payload || {};
      console.log('[MCP Bridge] save_config received:', Object.keys(payload));
      try {
        // Merge with existing config
        const existing = await chrome.storage.local.get(null);
        const merged = { ...existing };
        if (payload.providerKeys) {
          merged.providerKeys = { ...(existing.providerKeys || {}), ...payload.providerKeys };
        }
        if (payload.customModels) {
          merged.customModels = [...(existing.customModels || []), ...payload.customModels];
        }
        // Pass through other keys directly (model, provider, authMethod, etc.)
        for (const [k, v] of Object.entries(payload)) {
          if (k !== 'providerKeys' && k !== 'customModels') {
            merged[k] = v;
          }
        }
        await chrome.storage.local.set(merged);
        console.log('[MCP Bridge] Config saved');
        // Send confirmation back through relay
        if (command.requestId) {
          sendToMcpRelay({ type: 'config_saved', requestId: command.requestId, success: true });
        }
      } catch (err) {
        console.error('[MCP Bridge] save_config error:', err);
        if (command.requestId) {
          sendToMcpRelay({ type: 'config_saved', requestId: command.requestId, success: false, error: err.message });
        }
      }
      break;
    }

    case 'import_credentials': {
      // CLI setup wizard requests credential import (Claude Code or Codex).
      // Calls the import functions directly — chrome.runtime.sendMessage()
      // cannot message the service worker from within itself.
      const source = command.source; // 'claude' or 'codex'
      console.log('[MCP Bridge] import_credentials:', source);
      try {
        const importFn = source === 'claude' ? importCLICredentials
                       : source === 'codex'  ? importCodexCredentials
                       : null;
        if (!importFn) {
          throw new Error(`Unknown credential source: ${source}`);
        }
        const credentials = await importFn();
        await loadConfig();
        if (command.requestId) {
          sendToMcpRelay({ type: 'credentials_imported', requestId: command.requestId, success: true, credentials });
        }
      } catch (err) {
        console.error('[MCP Bridge] import_credentials error:', err);
        if (command.requestId) {
          sendToMcpRelay({ type: 'credentials_imported', requestId: command.requestId, success: false, error: err.message });
        }
      }
      break;
    }

    case 'get_info_response': {
      // Response from MCP server for a get_info request
      const pending = pendingGetInfoRequests.get(command.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(command.response);
        pendingGetInfoRequests.delete(command.requestId);
        debugLog('get_info response received', { requestId: command.requestId, response: command.response?.substring(0, 100) });
      } else {
        debugLog('get_info response for unknown request', command.requestId);
      }
      break;
    }

    case 'escalate_response': {
      // Response from planning agent for an escalation request
      const pendingEsc = pendingEscalateRequests.get(command.requestId);
      if (pendingEsc) {
        clearTimeout(pendingEsc.timeout);
        pendingEsc.resolve(command.response);
        pendingEscalateRequests.delete(command.requestId);
        debugLog('escalate response received', { requestId: command.requestId, response: command.response?.substring?.(0, 100) });
      } else {
        debugLog('escalate response for unknown request', command.requestId);
      }
      break;
    }

    case 'llm_request':
      // MCP server requesting LLM completion
      debugLog('llm_request received', { requestId: command.requestId, prompt: command.prompt?.substring(0, 50) });
      handleLLMRequest(command);
      break;

    // Handle managed task responses (from managed backend via relay)
    case 'task_started':
      managedTaskStopped = false; // Reset stop flag for new task
      chrome.runtime.sendMessage({
        type: 'TASK_UPDATE',
        update: { status: 'running', message: 'Task started on managed service...', taskId: command.taskId },
      }).catch(() => {});
      break;

    case 'task_update':
      chrome.runtime.sendMessage({
        type: 'TASK_UPDATE',
        update: {
          status: 'tool_use',
          tool: command.step?.tool || 'working',
          input: command.step?.input || {},
          steps: command.steps,
        },
      }).catch(() => {});
      break;

    case 'task_complete':
      chrome.runtime.sendMessage({
        type: 'TASK_COMPLETE',
        result: command.answer || 'Done',
      }).catch(() => {});
      // Hide overlay on ALL tabs
      try {
        const allTabs = await chrome.tabs.query({});
        for (const tab of allTabs) {
          if (tab.id) try { await chrome.tabs.sendMessage(tab.id, { type: 'HIDE_AGENT_INDICATORS' }); } catch { /* content script not injected */ }
        }
      } catch { /* tabs query failed */ }
      break;

    case 'task_error':
      chrome.runtime.sendMessage({
        type: 'TASK_ERROR',
        error: command.error || 'Task failed',
      }).catch(() => {});
      // Hide overlay on ALL tabs
      try {
        const allTabs2 = await chrome.tabs.query({});
        for (const tab of allTabs2) {
          if (tab.id) try { await chrome.tabs.sendMessage(tab.id, { type: 'HIDE_AGENT_INDICATORS' }); } catch { /* content script not injected */ }
        }
      } catch { /* tabs query failed */ }
      break;

    case 'execute_tool': {
      // Managed backend requesting tool execution (server-driven agent loop)
      // Tool execution targets the session-owned tab, NOT the global active tab.
      const { requestId, tool, input, browserSessionId: execSessionId, taskId: execTaskId } = command;
      debugLog('execute_tool received', { requestId, tool, browserSessionId: execSessionId });

      if (!requestId || !tool) {
        debugLog('execute_tool missing requestId or tool');
        break;
      }

      // Reset stop flag when a new task arrives (task_started may not have arrived yet)
      if (execTaskId && execTaskId !== globalThis._lastManagedTaskId) {
        managedTaskStopped = false;
        globalThis._lastManagedTaskId = execTaskId;
      }

      // If user clicked Stop, reject ALL tool executions until a new task starts
      if (managedTaskStopped) {
        sendToMcpRelay({
          type: 'tool_result',
          requestId,
          error: 'Task stopped by user',
        });
        break;
      }

      try {
        const { executeToolHandler, hasHandler } = toolHandlerModule;

        if (!hasHandler(tool)) {
          sendToMcpRelay({
            type: 'tool_result',
            requestId,
            error: `Unknown tool: ${tool}`,
          });
          break;
        }

        // Resolve the tab for this task.
        // Each task gets its own tab so parallel tasks don't fight over navigation.
        // Falls back to session-level tab if no taskId.
        const tabKey = execTaskId || execSessionId;
        let tabId = managedSessionTabs.get(tabKey);

        if (!tabId && tabKey) {
          // Try to restore from persistent storage
          try {
            const stored = await chrome.storage.local.get('managed_session_tabs');
            const persistedTabs = stored.managed_session_tabs || {};
            if (persistedTabs[tabKey]) {
              tabId = persistedTabs[tabKey];
              managedSessionTabs.set(tabKey, tabId);
              // Verify tab still exists
              try {
                await chrome.tabs.get(tabId);
              } catch {
                tabId = null; // Tab was closed
                managedSessionTabs.delete(tabKey);
              }
            }
          } catch { /* tab may already be closed */ }
        }

        // Verify the tab still exists — it may have been closed
        if (tabId) {
          try {
            await chrome.tabs.get(tabId);
          } catch {
            console.log('[MCP Bridge] Bound tab no longer exists, will create new one');
            tabId = null;
            managedSessionTabs.delete(tabKey);
          }
        }

        if (!tabId) {
          // No tab bound yet — create a dedicated tab for the agent to work in.
          try {
            const [focusedWin] = await chrome.windows.getAll({ windowTypes: ['normal'] }).then(wins => wins.filter(w => w.focused));
            const windowId = focusedWin?.id || (await chrome.windows.getLastFocused())?.id;
            const newTab = await chrome.tabs.create({ url: 'about:blank', active: false, windowId });
            tabId = newTab.id;
            if (tabId && tabKey) {
              managedSessionTabs.set(tabKey, tabId);
              const stored = (await chrome.storage.local.get('managed_session_tabs')).managed_session_tabs || {};
              stored[tabKey] = tabId;
              await chrome.storage.local.set({ managed_session_tabs: stored });
              console.log('[MCP Bridge] Created dedicated tab for task:', tabKey, 'tab:', tabId);
            }
          } catch (tabErr) {
            sendToMcpRelay({
              type: 'tool_result',
              requestId,
              error: 'Failed to create tab for managed session: ' + tabErr.message,
            });
            break;
          }
        }

        // Show "Powered by Hanzi Browse" overlay on the session tab
        try {
          await chrome.tabs.sendMessage(tabId, { type: 'SHOW_AGENT_INDICATORS', taskId: command.taskId || requestId });
        } catch { /* content script may not be ready yet */ }

        // Inject the session-owned tabId — tools read it from input directly
        const toolInput = { ...input, tabId };

        const deps = {
          sessionTabGroupId: null,
          log: (...args) => console.log('[execute_tool]', ...args),
          callLLMSimple: managedBrowserSessionId ? callLLMViaRelay : null,
        };

        const result = await executeToolHandler(tool, toolInput, deps);

        // Update persisted tab mapping if navigate changed the tab
        if (tool === 'navigate' && result?.tabId && result.tabId !== tabId) {
          managedSessionTabs.set(tabKey, result.tabId);
          const stored = (await chrome.storage.local.get('managed_session_tabs')).managed_session_tabs || {};
          stored[tabKey] = result.tabId;
          await chrome.storage.local.set({ managed_session_tabs: stored });
        }

        // Report tab context back to server so it can persist session ownership.
        // browserSessionId is required — without it, server writes to "" and persistence is broken.
        let tabContext = null;
        if (tabId) {
          try {
            const tab = await chrome.tabs.get(tabId);
            tabContext = { tabId, windowId: tab.windowId, url: tab.url, browserSessionId: execSessionId };
          } catch { /* tab may not exist */ }
        }

        sendToMcpRelay({
          type: 'tool_result',
          requestId,
          result: result?.output ?? result,
          tabContext, // Server can persist this
        });
      } catch (err) {
        console.error('[MCP Bridge] execute_tool error:', err);
        sendToMcpRelay({
          type: 'tool_result',
          requestId,
          error: err.message || String(err),
        });
      }
      break;
    }
  }
}

// Debug logging - writes to native host which saves to file
function debugLog(msg, data = null) {
  const entry = { time: new Date().toISOString(), msg, data };
  console.log('[MCP Debug]', msg, data || '');
  // Send to native host to write to debug log file
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    port.postMessage({ type: 'debug_log', entry });
    setTimeout(() => port.disconnect(), 50);
  } catch (_e) { /* Silent fail - native host may not be available */ }
}

/**
 * Send task update to MCP server
 */
export function sendMcpUpdate(sessionId, status, step) {
  debugLog('sendMcpUpdate called', { sessionId, status, step: step?.substring?.(0, 50), hasSes: mcpSessions.has(sessionId), sessions: Array.from(mcpSessions.keys()) });

  if (!mcpSessions.has(sessionId)) {
    debugLog('Session not found, skipping update');
    return;
  }

  mcpSessions.get(sessionId).status = status;

  if (!sendToMcpRelay(withSourceClientId(sessionId, {
    type: 'mcp_task_update',
    sessionId,
    status,
    step,
  }))) {
    console.warn('[MCP Bridge] Dropped task update because relay is disconnected', { sessionId, status });
    return;
  }
  debugLog('Update sent to relay');
}

/**
 * Send task completion to MCP server
 * Note: Session is NOT deleted - allows continuation via send_message
 */
export function sendMcpComplete(sessionId, result) {
  if (mcpSessions.has(sessionId)) {
    mcpSessions.get(sessionId).status = 'complete';
  }

  if (!sendToMcpRelay(withSourceClientId(sessionId, {
    type: 'mcp_task_complete',
    sessionId,
    result,
  }))) {
    console.warn('[MCP Bridge] Dropped task completion because relay is disconnected', { sessionId });
  }
}

/**
 * Send task error to MCP server
 * Note: Session is NOT deleted - allows retry via send_message
 */
export function sendMcpError(sessionId, error) {
  if (mcpSessions.has(sessionId)) {
    mcpSessions.get(sessionId).status = 'error';
  }

  if (!sendToMcpRelay(withSourceClientId(sessionId, {
    type: 'mcp_task_error',
    sessionId,
    error,
  }))) {
    console.warn('[MCP Bridge] Dropped task error because relay is disconnected', { sessionId });
  }
}

/**
 * Send screenshot to MCP server
 */
export function sendMcpScreenshot(sessionId, data) {
  if (!sendToMcpRelay(withSourceClientId(sessionId, {
    type: 'mcp_screenshot_result',
    sessionId,
    data,
  }, { clearPending: true }))) {
    console.warn('[MCP Bridge] Dropped screenshot response because relay is disconnected', { sessionId });
  }
}

/**
 * Query Mem0 for information via MCP server
 * This is used by the get_info tool to retrieve semantically relevant memories
 *
 * @param {string} sessionId - Session ID to search within
 * @param {string} query - Natural language query
 * @param {number} timeoutMs - Timeout in milliseconds (default: 10000)
 * @returns {Promise<string>} Response from Mem0 search
 */
export function queryMemory(sessionId, query, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const requestId = `get_info_${Date.now()}_${++getInfoRequestCounter}`;

    // Set up timeout
    const timeout = setTimeout(() => {
      pendingGetInfoRequests.delete(requestId);
      // Don't reject on timeout, just return a helpful message
      resolve(`Information lookup timed out. The query "${query}" could not be processed. You can:
1. Skip this field if it's optional
2. Use a reasonable default
3. Mention in your response that you couldn't retrieve this information`);
    }, timeoutMs);

    // Store the pending request
    pendingGetInfoRequests.set(requestId, { resolve, reject, timeout });

    // Send request to MCP server via relay
    if (!sendToMcpRelay(withSourceClientId(sessionId, {
      type: 'mcp_get_info',
      sessionId,
      query,
      requestId,
    }))) {
      clearTimeout(timeout);
      pendingGetInfoRequests.delete(requestId);
      resolve(`Information lookup unavailable because the MCP relay is disconnected. Use the provided task context directly if possible.`);
      return;
    }

    debugLog('get_info request sent', { sessionId, query, requestId });
  });
}

/**
 * Send escalation to MCP server (planning agent) for mid-task guidance.
 * Follows the same Promise-bridge pattern as queryMemory().
 *
 * @param {string} sessionId - Session ID
 * @param {string} problem - What the browser agent is stuck on
 * @param {string} whatITried - Approaches already attempted
 * @param {string} whatINeed - What would unblock the agent
 * @param {number} timeoutMs - Timeout (default 3 minutes — accounts for planning LLM call + possible user input)
 * @returns {Promise<string>} Guidance from planning agent
 */
export function sendEscalation(sessionId, problem, whatITried, whatINeed, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const requestId = `escalate_${Date.now()}_${++escalateRequestCounter}`;

    const timeout = setTimeout(() => {
      pendingEscalateRequests.delete(requestId);
      resolve('Escalation timed out. Continue with your best judgment or try a different approach.');
    }, timeoutMs);

    pendingEscalateRequests.set(requestId, { resolve, timeout });

    if (!sendToMcpRelay(withSourceClientId(sessionId, {
      type: 'mcp_escalate',
      sessionId,
      requestId,
      problem,
      whatITried: whatITried || '',
      whatINeed,
    }))) {
      clearTimeout(timeout);
      pendingEscalateRequests.delete(requestId);
      resolve('Escalation unavailable because the MCP relay is disconnected. Continue with your best judgment or request the missing information explicitly.');
      return;
    }

    debugLog('escalate request sent', { sessionId, problem, requestId });
  });
}

// Model tier → Anthropic model ID mapping for ccproxy
const CCPROXY_MODEL_MAP = {
  fast: 'claude-haiku-4-5-20251001',
  smart: 'claude-sonnet-4-5-20250929',
  powerful: 'claude-opus-4-5-20251101',
};

const CCPROXY_URL = 'http://127.0.0.1:8000/claude/v1/messages';

/**
 * Handle LLM request from MCP server
 * Routes directly to ccproxy (local Claude Code proxy) via fetch().
 * No native host needed — ccproxy handles credential injection.
 */
async function handleLLMRequest(command) {
  const { requestId, prompt, systemPrompt, maxTokens, modelTier } = command;
  const model = CCPROXY_MODEL_MAP[modelTier] || CCPROXY_MODEL_MAP.smart;

  try {
    debugLog('llm_request via ccproxy', { requestId, model, modelTier: modelTier || 'smart' });

    const body = {
      model,
      max_tokens: maxTokens || 2000,
      messages: [{ role: 'user', content: prompt }],
      ...(systemPrompt ? { system: systemPrompt } : {}),
    };

    const response = await fetch(CCPROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ccproxy ${response.status}: ${errorText.substring(0, 200)}`);
    }

    const result = await response.json();

    // Extract text content from Anthropic Messages API response
    const content = result.content?.find(b => b.type === 'text')?.text || '';

    if (!sendToMcpRelay({
      type: 'mcp_llm_response',
      requestId,
      content,
      usage: result.usage,
    })) {
      console.warn('[MCP Bridge] Dropped llm_response because relay is disconnected', { requestId });
    }

    debugLog('llm_request completed', { requestId, contentLength: content.length });
  } catch (error) {
    console.error('[MCP Bridge] LLM request failed:', error);

    if (!sendToMcpRelay({
      type: 'mcp_llm_response',
      requestId,
      error: error.message || 'LLM request failed',
    })) {
      console.warn('[MCP Bridge] Dropped llm_response error because relay is disconnected', { requestId });
    }

    debugLog('llm_request failed', { requestId, error: error.message });
  }
}

/**
 * Get MCP session data (including context)
 */
export function getMcpSession(sessionId) {
  return mcpSessions.get(sessionId);
}

/**
 * Send message to MCP server/CLI over the WebSocket relay.
 * MCP task transport requires relay connectivity.
 */
export function sendToMcpRelay(message) {
  const sock = getRelaySocket();
  if (!sock || sock.readyState !== WebSocket.OPEN) {
    return false;
  }

  const wsMessage = normalizeOutgoingMessage(message);
  sock.send(JSON.stringify(wsMessage));
  return true;
}

/**
 * Normalize outgoing messages from extension format to the format
 * expected by MCP server/CLI consumers.
 *
 * Native host bridge translates mcp_task_update → task_update etc.
 * For WebSocket, we do this translation here.
 */
function normalizeOutgoingMessage(message) {
  const { type, ...rest } = message;

  // Map from extension message types to consumer-expected types
  const typeMap = {
    'mcp_task_update': 'task_update',
    'mcp_task_complete': 'task_complete',
    'mcp_task_error': 'task_error',
    'mcp_screenshot_result': 'screenshot',
    'mcp_get_info': 'mcp_get_info',
    'mcp_escalate': 'mcp_escalate',
    'mcp_llm_response': 'llm_response',
  };

  const mappedType = typeMap[type] || type;
  return { type: mappedType, ...rest };
}

/**
 * Check if a session is an MCP session
 */
export function isMcpSession(sessionId) {
  return mcpSessions.has(sessionId);
}

/**
 * Get all active MCP sessions
 */
export function getMcpSessions() {
  return Array.from(mcpSessions.keys());
}

// relayRequest and proxyApiCall moved to relay-client.js
