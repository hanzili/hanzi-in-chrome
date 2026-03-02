/**
 * MCP Bridge Module
 *
 * Enables communication between MCP server and the Chrome extension.
 * Primary: WebSocket relay (ws://localhost:7862) for real-time messaging.
 * Fallback: Native host file-based IPC polling when WebSocket is unavailable.
 *
 * The service worker can sleep at any time, dropping the WebSocket.
 * On wake, connectToRelay() reconnects. During disconnection, native
 * messaging polling keeps things working.
 */


const NATIVE_HOST_NAME = 'com.hanzi_in_chrome.oauth_host';
const POLL_INTERVAL_MS = 500;
const WS_RELAY_URL = 'ws://localhost:7862';
const WS_RECONNECT_DELAY_MS = 5000;

let pollInterval = null;
let isPolling = false;

// WebSocket connection to relay server
let relaySocket = null;
let wsReconnectTimer = null;

// Active MCP sessions
const mcpSessions = new Map();

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
 * Tries WebSocket relay first, falls back to native host polling.
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
 * On success, stops native polling (WebSocket is faster and push-based).
 * On failure/disconnect, starts native polling as fallback and schedules reconnect.
 */
export function connectToRelay() {
  // Clear any pending reconnect
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  // Don't reconnect if already connected
  if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
    return;
  }

  try {
    console.log('[MCP Bridge] Connecting to WebSocket relay:', WS_RELAY_URL);
    relaySocket = new WebSocket(WS_RELAY_URL);

    relaySocket.onopen = () => {
      console.log('[MCP Bridge] WebSocket connected');

      // Register as the extension client
      relaySocket.send(JSON.stringify({ type: 'register', role: 'extension' }));

      // WebSocket is faster — stop polling to reduce overhead
      stopMcpPolling();
    };

    relaySocket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        // Skip registration acknowledgements
        if (message.type === 'registered' || message.type === 'error') {
          if (message.type === 'error') {
            console.warn('[MCP Bridge] Relay error:', message.error);
          }
          return;
        }

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

    relaySocket.onclose = () => {
      console.log('[MCP Bridge] WebSocket disconnected');
      relaySocket = null;

      // Fall back to native polling
      startMcpPolling();

      // Schedule reconnect
      wsReconnectTimer = setTimeout(() => {
        connectToRelay();
      }, WS_RECONNECT_DELAY_MS);
    };

    relaySocket.onerror = (_err) => {
      console.log('[MCP Bridge] WebSocket error (relay may not be running)');
      // onclose will fire after this, handling fallback
    };
  } catch (e) {
    console.log('[MCP Bridge] WebSocket connection failed:', e.message);
    // Ensure polling is running as fallback
    startMcpPolling();

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
    'mcp_poll_results': null, // Not applicable over WebSocket (push-based)
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
export function isRelayConnected() {
  return relaySocket && relaySocket.readyState === WebSocket.OPEN;
}

/**
 * Start polling for MCP commands
 */
export function startMcpPolling() {
  if (pollInterval) return;

  console.log('[MCP Bridge] Starting polling');
  pollInterval = setInterval(pollForCommands, POLL_INTERVAL_MS);
}

/**
 * Stop polling
 */
export function stopMcpPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  console.log('[MCP Bridge] Stopped polling');
}

/**
 * Poll native host for MCP commands
 */
async function pollForCommands() {
  if (isPolling) return;
  isPolling = true;

  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        port.disconnect();
        resolve(null);
      }, 1000);

      port.onMessage.addListener((message) => {
        clearTimeout(timeout);
        port.disconnect();
        resolve(message);
      });

      port.onDisconnect.addListener(() => {
        clearTimeout(timeout);
        resolve(null);
      });

      port.postMessage({ type: 'poll_mcp_inbox' });
    });

    if (result?.type === 'mcp_commands' && result.commands?.length > 0) {
      for (const cmd of result.commands) {
        await handleMcpCommand(cmd);
      }
    }
  } catch (e) {
    // Silent fail - native host might not be available
  } finally {
    isPolling = false;
  }
}

/**
 * Handle an MCP command from the inbox
 */
async function handleMcpCommand(command) {
  console.log('[MCP Bridge] Received command:', command.type, command.sessionId);

  switch (command.type) {
    case 'start_task':
      if (onStartTask) {
        debugLog('Adding session to mcpSessions', command.sessionId);
        mcpSessions.set(command.sessionId, { status: 'starting', context: command.context });
        debugLog('mcpSessions now has', Array.from(mcpSessions.keys()));
        onStartTask(command.sessionId, command.task, command.url, command.context, command.licenseKey);
      }
      break;

    case 'send_message':
      // Allow send_message even if session is complete/error (for continuation)
      // The service worker will validate if the session actually exists
      if (onSendMessage) {
        onSendMessage(command.sessionId, command.message);
      }
      break;

    case 'stop_task':
      if (onStopTask && mcpSessions.has(command.sessionId)) {
        const shouldRemove = command.remove === true;
        onStopTask(command.sessionId, shouldRemove);
        // Only delete from bridge if removing completely
        if (shouldRemove) {
          mcpSessions.delete(command.sessionId);
        }
      }
      break;

    case 'screenshot':
      if (onScreenshot) {
        onScreenshot(command.sessionId);
      }
      break;

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

  sendToNativeHost({
    type: 'mcp_task_update',
    sessionId,
    status,
    step,
  });
  debugLog('Update sent to native host');
}

/**
 * Send task completion to MCP server
 * Note: Session is NOT deleted - allows continuation via send_message
 */
export function sendMcpComplete(sessionId, result) {
  if (mcpSessions.has(sessionId)) {
    mcpSessions.get(sessionId).status = 'complete';
  }

  sendToNativeHost({
    type: 'mcp_task_complete',
    sessionId,
    result,
  });
}

/**
 * Send task error to MCP server
 * Note: Session is NOT deleted - allows retry via send_message
 */
export function sendMcpError(sessionId, error) {
  if (mcpSessions.has(sessionId)) {
    mcpSessions.get(sessionId).status = 'error';
  }

  sendToNativeHost({
    type: 'mcp_task_error',
    sessionId,
    error,
  });
}

/**
 * Send screenshot to MCP server
 */
export function sendMcpScreenshot(sessionId, data) {
  sendToNativeHost({
    type: 'mcp_screenshot_result',
    sessionId,
    data,
  });
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

    // Send request to MCP server via native host
    sendToNativeHost({
      type: 'mcp_get_info',
      sessionId,
      query,
      requestId,
    });

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

    sendToNativeHost({
      type: 'mcp_escalate',
      sessionId,
      requestId,
      problem,
      whatITried: whatITried || '',
      whatINeed,
    });

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

    sendToNativeHost({
      type: 'mcp_llm_response',
      requestId,
      content,
      usage: result.usage,
    });

    debugLog('llm_request completed', { requestId, contentLength: content.length });
  } catch (error) {
    console.error('[MCP Bridge] LLM request failed:', error);

    sendToNativeHost({
      type: 'mcp_llm_response',
      requestId,
      error: error.message || 'LLM request failed',
    });

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
 * Send message to MCP server/CLI.
 * Routes through WebSocket relay when connected, falls back to native host.
 */
function sendToNativeHost(message) {
  // Try WebSocket first (real-time, no file I/O)
  if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
    try {
      // Normalize outgoing message types for the relay
      // The relay broadcasts to all MCP/CLI consumers
      const wsMessage = normalizeOutgoingMessage(message);
      relaySocket.send(JSON.stringify(wsMessage));
      return;
    } catch (e) {
      console.warn('[MCP Bridge] WebSocket send failed, falling back to native host:', e.message);
    }
  }

  // Fall back to native host (file-based IPC)
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    port.postMessage(message);
    setTimeout(() => port.disconnect(), 100);
  } catch (e) {
    console.error('[MCP Bridge] Send error:', e);
  }
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
