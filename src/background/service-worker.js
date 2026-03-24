/**
 * Service Worker - Hanzi in Chrome
 *
 * Orchestrates browser automation by:
 * 1. Receiving tasks from the sidepanel
 * 2. Calling LLM API with tools
 * 3. Executing tool calls via content scripts
 * 4. Looping until task is complete
 */

import { getDomainSkills } from './modules/domain-skills.js';
import {
  loadConfig, getConfig, setConfig,
  createAbortController, abortRequest,
  callLLM, callLLMSimple, resetApiCallCounter, getApiCallCount, isClaudeProvider, resolveAgentDefaultConfig
} from './modules/api.js';
import { getMemoryStats } from './modules/memory-manager.js';
import { compactIfNeeded, calculateContextTokens } from './modules/conversation-compaction.js';
import { startOAuthLogin, importCLICredentials, logout, getAuthStatus } from './modules/oauth-manager.js';
import { importCodexCredentials, logoutCodex, getCodexAuthStatus } from './modules/codex-oauth-manager.js';
import { hasHandler, executeToolHandler } from './tool-handlers/index.js';
import { log, clearLog, saveTaskLogs, initLogging, registerTaskLogging, unregisterTaskLogging } from './managers/logging-manager.js';
import { startSession, resetTaskUsage, recordApiCall, recordTaskCompletion, getTaskUsage } from './managers/usage-tracker.js';
import {
  ensureDebugger,
  detachDebugger,
  sendDebuggerCommand,
  initDebugger,
  isNetworkTrackingEnabled,
  enableNetworkTracking,
  setPopupCallbacks,
  registerDebuggerSession,
  unregisterDebuggerSession,
  getConsoleMessages,
  clearConsoleMessages,
  getNetworkRequests,
  clearNetworkRequests,
  getCapturedCaptchaData,
  clearDebuggerSession,
} from './managers/debugger-manager.js';
import { showAgentIndicators, hideAgentIndicators, hideIndicatorsForToolUse, showIndicatorsAfterToolUse } from './managers/indicator-manager.js';
import { ensureTabGroup, addTabToGroup, validateTabInGroup, isTabManagedByAgent, registerTabCleanupListener, initTabManager } from './managers/tab-manager.js';
import {
  initMcpBridge, sendMcpUpdate, sendMcpComplete, sendMcpError, sendMcpScreenshot, queryMemory, sendEscalation,
  setManagedSession, clearManagedSession, getManagedSessionInfo,
} from './modules/mcp-bridge.js';
import { checkAndIncrementUsage, activateLicense, getLicenseStatus, deactivateLicense } from './managers/license-manager.js';

// ============================================
// CONSTANTS
// ============================================

// Maximum number of concurrent task windows (each task gets its own window)
const MAX_CONCURRENT_TASK_WINDOWS = 5;
const LLM_WATCHDOG_TIMEOUT_MS = 180000;

// ============================================
// STATE
// ============================================

// Task debug log - shared with logging manager
let taskDebugLog = [];
initLogging(taskDebugLog);

// ============================================
// STATE
// ============================================

const uiSessionState = {
  currentTask: null,
  cancelled: false,
  conversationHistory: [], // Persists across tasks in the same chat session
  taskScreenshots: [],
};

// Screenshot storage for computer tool screenshots
const capturedScreenshotsByScope = new Map();

// Screenshot context tracking
// Maps screenshot ID to {viewportWidth, viewportHeight, screenshotWidth, screenshotHeight, devicePixelRatio}
let screenshotContexts = new Map();

// Plan approval state
const pendingPlanResolves = new Map();

// Session metadata (removed - not used)

// ARCHITECTURAL CHANGE: sessionTabGroupId removed from global state
// Tab groups are now managed by the UI/client and passed as parameters
// Multi-session support

// Track tabs opened BY agent actions (popups, new windows from clicks)
// For parallel execution, this is per-session in mcpSessions
const agentOpenedTabs = new Set();

// Track active agent sessions (Set of sessionIds for parallel execution)
// For UI-triggered tasks (non-MCP), we use a special ID: 'ui-task'
const activeSessions = new Set();

// Per-session state for MCP tasks (moved here for early access by popup callbacks)
// Each session has its own chat history, tab, and status
const mcpSessions = new Map(); // sessionId -> { tabId, task, messages, status, tabStack, ... }
const MCP_SESSION_STORAGE_KEY = 'mcp_sessions_v1';

// Legacy compatibility: check if any session is active
const isAnySessionActive = () => activeSessions.size > 0;

function getPlanScopeId(sessionId = null) {
  return sessionId || 'ui-task';
}

function setPendingPlanResolver(scopeId, resolver) {
  pendingPlanResolves.set(getPlanScopeId(scopeId), resolver);
}

function resolvePendingPlan(scopeId, payload) {
  const resolvedScopeId = getPlanScopeId(scopeId);
  const resolver = pendingPlanResolves.get(resolvedScopeId);
  if (!resolver) return false;
  pendingPlanResolves.delete(resolvedScopeId);
  resolver(payload);
  return true;
}

function getScreenshotScopeId(sessionId = null) {
  return sessionId || 'default';
}

function getCapturedScreenshots(sessionId = null) {
  const scopeId = getScreenshotScopeId(sessionId);
  if (!capturedScreenshotsByScope.has(scopeId)) {
    capturedScreenshotsByScope.set(scopeId, new Map());
  }
  return capturedScreenshotsByScope.get(scopeId);
}

function clearCapturedScreenshots(sessionId = null) {
  getCapturedScreenshots(sessionId).clear();
}

function removeCapturedScreenshots(sessionId = null) {
  capturedScreenshotsByScope.delete(getScreenshotScopeId(sessionId));
}

function serializeMcpSession(session) {
  return {
    sessionId: session.sessionId,
    tabId: session.tabId,
    windowId: session.windowId,
    url: session.url,
    task: session.task,
    context: session.context,
    messages: session.messages || [],
    status: session.status === 'running' ? 'stopped' : session.status,
    createdAt: session.createdAt,
    screenshots: [],
    debugLog: [],
    steps: session.steps || [],
    openedTabs: Array.from(session.openedTabs || []),
    tabStack: session.tabStack || [],
    startTime: session.startTime || null,
    endTime: session.endTime || null,
    result: session.result || null,
    modelConfig: session.modelConfig || null,
  };
}

async function persistMcpSessions() {
  const snapshot = Array.from(mcpSessions.values()).map(serializeMcpSession);
  await chrome.storage.local.set({ [MCP_SESSION_STORAGE_KEY]: snapshot });
}

async function restoreMcpSessions() {
  try {
    const data = await chrome.storage.local.get([MCP_SESSION_STORAGE_KEY]);
    const snapshot = Array.isArray(data[MCP_SESSION_STORAGE_KEY]) ? data[MCP_SESSION_STORAGE_KEY] : [];

    for (const stored of snapshot) {
      if (!stored?.sessionId) continue;
      mcpSessions.set(stored.sessionId, {
        sessionId: stored.sessionId,
        tabId: stored.tabId,
        windowId: stored.windowId,
        url: stored.url,
        task: stored.task,
        context: stored.context,
        messages: stored.messages || [],
        status: stored.status === 'running' ? 'stopped' : stored.status,
        cancelled: false,
        createdAt: stored.createdAt || Date.now(),
        screenshots: [],
        debugLog: [],
        steps: stored.steps || [],
        openedTabs: new Set(stored.openedTabs || []),
        tabStack: stored.tabStack || [],
        startTime: stored.startTime || null,
        endTime: stored.endTime || null,
        result: stored.result || null,
        modelConfig: stored.modelConfig || null,
        abortController: new AbortController(),
        runPromise: null,
        cancelReason: null,
      });
    }

    if (snapshot.length > 0) {
      console.log(`[MCP] Restored ${snapshot.length} persisted session(s)`);
    }
  } catch (error) {
    console.warn('[MCP] Failed to restore persisted sessions:', error.message);
  }
}

/**
 * ============================================================================
 * POPUP/WINDOW TRACKING
 * ============================================================================
 *
 * The listeners below (chrome.tabs.onCreated, chrome.windows.onCreated) were
 * designed to automatically track popup windows and new tabs opened by agent
 * actions (e.g., payment flows, OAuth redirects, external links).
 *
 * STATUS: DISABLED (but tracking still works via tabs_context tool)
 *
 * KNOWN ISSUE - CHROME FULLSCREEN BUG:
 * Chrome crashes when a new tab is created in the same window while in
 * fullscreen mode. This is a Chrome-level bug, not caused by our extension.
 * Disabling these listeners doesn't fix the crash, but we keep them disabled
 * to reduce any potential interference.
 *
 * WHAT WORKS:
 * - Non-fullscreen mode: New tabs and popups are tracked correctly
 * - Fullscreen + new popup window: Works fine
 * - Fullscreen + new tab (same window): Chrome crashes (Chrome bug)
 *
 * WORKAROUND FOR DEMOS:
 * Run the agent in non-fullscreen mode if the workflow involves opening
 * new tabs in the same window (e.g., payment checkouts).
 *
 * NOTE: Even with these listeners disabled, the tabs_context tool still
 * correctly detects new tabs via chrome.tabs.query. The agent successfully
 * handles payment flows and multi-tab interactions in non-fullscreen mode.
 *
 * TO RE-ENABLE (if needed):
 * 1. Remove the early `return;` statements in both listeners
 * 2. Test thoroughly in fullscreen mode
 * ============================================================================
 */

// Listen for new tabs and track ones that might be opened by agent actions
chrome.tabs.onCreated.addListener(async (tab) => {
  // DISABLED: This was causing browser crashes in fullscreen mode
  return;

  // DISABLED CODE BELOW (unreachable):
  // If no active session, don't track
  // eslint-disable-next-line no-unreachable, no-undef
  if (!isAnySessionActive()) return;

  console.log(`[TAB TRACKING] New tab created: ${tab.id}, openerTabId: ${tab.openerTabId}, windowId: ${tab.windowId}`);

  // Track if opener is one of our managed tabs
  if (tab.openerTabId) {
    const isOpenerManaged = await isTabManagedByAgent(tab.openerTabId);
    if (isOpenerManaged) {
      agentOpenedTabs.add(tab.id);
      console.log(`[TAB TRACKING] Tracking tab ${tab.id} (opened by agent tab ${tab.openerTabId})`);
      return;
    }
  }

  // Also track tabs in new popup windows that appear during active session
  // These might be payment popups, OAuth flows, etc.
  try {
    const window = await chrome.windows.get(tab.windowId);
    if (window.type === 'popup' && isAnySessionActive()) {
      agentOpenedTabs.add(tab.id);
      console.log(`[TAB TRACKING] Tracking popup tab ${tab.id} (popup window during active session)`);
    }
  } catch (e) {
    // Window might not exist
  }
});

// Listen for new windows (catches popup windows)
// NOTE: Disabled to fix browser crashes in fullscreen mode
chrome.windows.onCreated.addListener(async (window) => {
  // DISABLED: This was causing browser crashes in fullscreen mode
  return;

  // DISABLED CODE BELOW (unreachable):
  // eslint-disable-next-line no-unreachable
  if (!isAnySessionActive()) return;

  console.log(`[WINDOW TRACKING] New window created: ${window.id}, type: ${window.type}`);

  // If it's a popup window during an active session, track its tabs
  if (window.type === 'popup') {
    // Wait a moment for tabs to be created in the window
    await new Promise(r => setTimeout(r, 100));

    const tabs = await chrome.tabs.query({ windowId: window.id });
    for (const tab of tabs) {
      if (!agentOpenedTabs.has(tab.id)) {
        agentOpenedTabs.add(tab.id);
        console.log(`[WINDOW TRACKING] Tracking tab ${tab.id} from popup window ${window.id}`);
      }
    }
  }
});

// Clean up tracking when tabs are closed
chrome.tabs.onRemoved.addListener((_tabId) => {
  // Tab cleanup handled by tab manager now
});

// Tab management delegated to tab-manager.js
// Initialize tab manager with shared state
// NOTE: sessionTabGroupId removed - now passed as parameter from client
registerTabCleanupListener(agentOpenedTabs);
initTabManager({ agentOpenedTabs, isAnySessionActive, log });

// ============================================
// DEBUGGER MANAGEMENT
// Debugger and indicator management delegated to manager modules
initDebugger({ log });

// ============================================
// POPUP TRACKING CALLBACKS
// ============================================
// When a popup opens (e.g., OAuth flow), shift agent attention to it
// When popup closes, return attention to the original tab

setPopupCallbacks({
  onOpened: async (popupTabId, openerTabId) => {
    console.log(`[POPUP] Shifting attention: popup ${popupTabId} opened by ${openerTabId}`);

    // Find which MCP session owns the opener tab
    for (const [sessionId, session] of mcpSessions.entries()) {
      if (session.tabId === openerTabId && session.status === 'running') {
        // Initialize tabStack if needed
        if (!session.tabStack) {
          session.tabStack = [];
        }

        // Push current tab onto stack and shift to popup
        session.tabStack.push(session.tabId);
        session.tabId = popupTabId;
        session.openedTabs.add(popupTabId);
        void persistMcpSessions();

        // Attach debugger to popup so we can interact with it
        await ensureDebugger(popupTabId, sessionId);

        // Show agent indicators on popup
        await showAgentIndicators(popupTabId);

        console.log(`[POPUP] Session ${sessionId} now focused on popup ${popupTabId} (stack: [${session.tabStack.join(', ')}])`);

        // Notify MCP server about the focus shift
        sendMcpUpdate(sessionId, 'running', `[Popup opened] Now interacting with popup window. Will return to original tab when done.`);
        break;
      }
    }
  },

  onClosed: async (popupTabId, openerTabId) => {
    console.log(`[POPUP] Popup ${popupTabId} closed, returning to ${openerTabId}`);

    // Find which MCP session was using this popup
    for (const [sessionId, session] of mcpSessions.entries()) {
      if (session.tabId === popupTabId && session.status === 'running') {
        // Pop from stack to return to previous tab
        if (session.tabStack && session.tabStack.length > 0) {
          const previousTabId = session.tabStack.pop();
          session.tabId = previousTabId;
          void persistMcpSessions();

          // Show agent indicators on previous tab
          await showAgentIndicators(previousTabId);

          console.log(`[POPUP] Session ${sessionId} returned to tab ${previousTabId} (stack: [${session.tabStack.join(', ')}])`);

          // Notify MCP server about the return
          sendMcpUpdate(sessionId, 'running', `[Popup closed] Returned to original tab. Continuing task.`);
        }
        break;
      }
    }
  }
});

// ============================================
// CONTENT SCRIPT COMMUNICATION
// ============================================

async function ensureContentScripts(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' }, { frameId: 0 });
    return true;
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        files: ['src/content/accessibility-tree.js', 'src/content/content.js'],
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      return true;
    } catch (injectError) {
      console.error('Failed to inject content scripts:', injectError);
      return false;
    }
  }
}

/**
 * Send a message to a tab's content script
 * @param {number} tabId - Tab ID to send message to
 * @param {string} type - Message type
 * @param {Object} [payload] - Message payload
 * @returns {Promise<*>} Response from content script
 */
async function sendToContent(tabId, type, payload = {}) {
  await ensureContentScripts(tabId);
  return await chrome.tabs.sendMessage(tabId, { type, payload }, { frameId: 0 });
}

// ============================================
// ERROR MESSAGE ENHANCEMENT
// ============================================

/**
 * Enhance error messages with additional context for the LLM
 * Prevents retry loops on non-retryable errors
 * @param {string} errorMessage - Original error message
 * @returns {string} Enhanced error message with context
 */
function enhanceErrorMessage(errorMessage) {
  if (!errorMessage || typeof errorMessage !== 'string') {
    return errorMessage;
  }

  // Permission denial - prevent infinite retry loops
  if (errorMessage.toLowerCase().includes('permission denied') ||
      errorMessage.toLowerCase().includes('user declined') ||
      errorMessage.toLowerCase().includes('user denied')) {
    return `${errorMessage}\n\nThe user has declined this action. Ask how to proceed instead.`;
  }

  // Restricted pages - explain Chrome's limitations (not obvious to LLM)
  if (errorMessage.includes('chrome://') ||
      errorMessage.includes('Chrome blocks extensions') ||
      errorMessage.includes('about:')) {
    return `${errorMessage}\n\nChrome blocks extensions from system pages.`;
  }

  // Return original error for everything else
  return errorMessage;
}

// ============================================
// TOOL EXECUTION
// ============================================

/** Check if a tab URL is accessible by content scripts */
function isAccessibleTab(tab) {
  const url = tab.url || '';
  return url && !url.startsWith('chrome://') && !url.startsWith('about:') && !url.startsWith('chrome-extension://');
}

/**
 * Resolve the active tab for a session when the agent didn't specify one.
 * @param {Object|null} mcpSession - MCP session with windowId
 * @param {number|null} sessionTabGroupId - Tab group ID for UI sessions
 * @param {Object} [options]
 * @param {boolean} [options.allowRestricted=false] - If true, return tabs with restricted URLs (for navigate)
 * @returns {number|null} Tab ID or null if unresolvable
 */
async function resolveActiveTab(mcpSession, sessionTabGroupId, { allowRestricted = false } = {}) {
  const tabOk = allowRestricted ? (t) => !!t.id : isAccessibleTab;

  // MCP session with dedicated window — find active tab in that window
  if (mcpSession?.windowId) {
    try {
      const win = await chrome.windows.get(mcpSession.windowId, { populate: true });
      const activeTab = (win.tabs || []).find(t => t.active && tabOk(t));
      if (activeTab) return activeTab.id;
      const firstTab = (win.tabs || []).find(t => tabOk(t));
      if (firstTab) return firstTab.id;
    } catch {
      // Window gone
    }
  }

  // Tab group session — find active tab in the group
  if (sessionTabGroupId !== null) {
    try {
      const groupTabs = await chrome.tabs.query({ groupId: sessionTabGroupId, active: true });
      const accessible = groupTabs.find(t => tabOk(t));
      if (accessible) return accessible.id;
      const allGroupTabs = await chrome.tabs.query({ groupId: sessionTabGroupId });
      const anyAccessible = allGroupTabs.find(t => tabOk(t));
      if (anyAccessible) return anyAccessible.id;
    } catch {
      // Query failed
    }
  }

  // No last-resort fallback — never grab an unrelated user tab
  return null;
}

/**
 * Execute a tool and return its result
 * @param {string} toolName - Name of the tool to execute (e.g., 'computer', 'navigate', 'read_page')
 * @param {Object} toolInput - Tool-specific input parameters
 * @param {number} [toolInput.tabId] - Tab ID to operate on (optional, auto-resolved if missing)
 * @param {string} [toolInput.action] - Action to perform (for computer tool)
 * @param {string} [toolInput.url] - URL to navigate to (for navigate tool)
 * @param {number|null} [sessionTabGroupId] - Current session tab group ID (from client)
 * @param {Object|null} [mcpSession] - MCP session with context for get_info tool
 * @returns {Promise<Object|string>} Tool execution result or error message
 */
async function executeTool(toolName, toolInput, sessionTabGroupId = null, mcpSession = null, options = {}) {
  const sessionId = mcpSession?.sessionId || null;
  const planScopeId = options.planScopeId || getPlanScopeId(sessionId);
  const allowPlanApproval = options.askBeforeActing ?? true;
  const taskLog = (type, message, data = null) => log(type, message, data, { sessionId });
  const sessionCapturedScreenshots = getCapturedScreenshots(sessionId);
  const sessionOpenedTabs = mcpSession?.openedTabs || agentOpenedTabs;
  await taskLog('TOOL', `Executing: ${toolName}`, toolInput);

  // Shallow copy to avoid mutating the LLM response object stored in conversation history
  toolInput = { ...toolInput };

  // Auto-resolve tabId: if the agent didn't provide one, use the active tab in the session's window
  // tabs_close is excluded — it always requires an explicit tabId
  const tabTools = ['computer', 'read_page', 'find', 'form_input', 'get_page_text',
                    'javascript_tool', 'file_upload', 'read_console_messages', 'read_network_requests',
                    'resize_window', 'solve_captcha', 'navigate'];
  if (!toolInput.tabId && tabTools.includes(toolName)) {
    // navigate can work on restricted tabs (chrome://, about:) since it changes the URL
    const allowRestricted = toolName === 'navigate';
    const resolved = await resolveActiveTab(mcpSession, sessionTabGroupId, { allowRestricted });
    if (resolved) {
      toolInput.tabId = resolved;
    }
  }

  const tabId = toolInput.tabId;

  // Validate tab is in our group (for tools that use tabId)
  // Skip URL validation for navigate tool since it changes the URL anyway
  if (tabId && tabTools.includes(toolName) && toolName !== 'navigate') {
    const validation = await validateTabInGroup(tabId, sessionTabGroupId);
    if (!validation.valid) {
      return validation.error;
    }
  }

  // For navigate tool, only check if tab is managed (not URL restrictions)
  if (toolName === 'navigate' && tabId) {
    if (sessionTabGroupId === null) {
      // No group yet - allow first navigation
    } else {
      const isManaged = await isTabManagedByAgent(tabId, sessionTabGroupId);
      if (!isManaged) {
        return `Tab ${tabId} is not managed by the Agent. Use tabs_context to see available tabs.`;
      }
    }
  }

  // Use extracted handler if available
  if (hasHandler(toolName)) {
    const deps = {
      sendDebuggerCommand,
      ensureDebugger: (tabId) => ensureDebugger(tabId, sessionId),
      log: taskLog,
      sendToContent,
      hideIndicatorsForToolUse,
      showIndicatorsAfterToolUse,
      capturedScreenshots: sessionCapturedScreenshots,
      screenshotContexts,
      taskScreenshots: uiSessionState.taskScreenshots,
      agentOpenedTabs: sessionOpenedTabs,
      sessionTabGroupId,
      isAnySessionActive,
      addTabToGroup,
      ensureContentScripts,
      getConfig,
      // MCP tasks use their own session-level model config so automation can have
      // a different default from the sidepanel.
      callLLMSimple: mcpSession
        ? async (promptOrOptions, maxTokensArg) => {
            if (typeof promptOrOptions === 'object' && promptOrOptions.messages) {
              return callLLMSimple({ ...promptOrOptions, configOverride: mcpSession.modelConfig }, maxTokensArg);
            }
            const result = await callLLMSimple({
              messages: [{ role: 'user', content: promptOrOptions }],
              maxTokens: maxTokensArg || 800,
              configOverride: mcpSession.modelConfig
            });
            return result.content?.find(b => b.type === 'text')?.text || '';
          }
        : callLLMSimple,
      getConsoleMessages: () => getConsoleMessages(sessionId),
      clearConsoleMessages: () => clearConsoleMessages(sessionId),
      getNetworkRequests: () => getNetworkRequests(sessionId),
      clearNetworkRequests: () => clearNetworkRequests(sessionId),
      isNetworkTrackingEnabled,
      enableNetworkTracking,
      getCapturedCaptchaData: () => getCapturedCaptchaData(sessionId),
      askBeforeActing: allowPlanApproval,
      setPendingPlanResolve: (resolver) => { setPendingPlanResolver(planScopeId, resolver); },
      mcpSession,  // For get_info tool to access task context
      queryMemory, // For get_info tool to query Mem0 via MCP server
      sendEscalation, // For escalate tool to send escalation via MCP bridge
      sessionId, // For escalate tool to identify the session
    };
    return await executeToolHandler(toolName, toolInput, deps);
  }

  // All tools have been migrated to handlers - this should never be reached
  return `Error: Unknown tool ${toolName}`;
}

// ============================================
// AGENT LOOP
// ============================================

/**
 * Main agent loop - coordinates with LLM to execute a task
 * @param {number} initialTabId - Tab ID to start the task in
 * @param {string} task - Natural language task description
 * @param {Function} onUpdate - Callback for status updates (receives {status, message, data})
 * @param {Array<string>} [images] - Array of base64 image data URLs to include in initial message
 * @param {boolean} [askBeforeActing] - Whether to ask user before executing actions
 * @param {Array<Object>} [existingHistory] - Existing conversation history to continue from
 * @param {number|null} [initialTabGroupId] - Optional initial tab group ID from client
 * @returns {Promise<Object>} Task result with {success: boolean, message: string, error?: string}
 */
async function runAgentLoop(initialTabId, task, onUpdate, images = [], askBeforeActing = true, existingHistory = [], initialTabGroupId = null, mcpSession = null) {
  const sessionId = mcpSession?.sessionId || null;
  const taskLog = (type, message, data = null) => log(type, message, data, { sessionId });
  const clearTaskLog = () => clearLog({ sessionId });
  const isRunCancelled = () => (mcpSession ? !!mcpSession.cancelled : uiSessionState.cancelled);

  // Only clear storage log for fresh tasks, not follow-ups (preserves debug history)
  const isFollowUp = existingHistory.length > 0;
  if (!isFollowUp) {
    await clearTaskLog();
  }
  await taskLog('START', 'Agent loop started', { tabId: initialTabId, task: task.substring(0, 100), isFollowUp });

  // Load config first to ensure userSkills and other settings are available
  await loadConfig();

  // Create or adopt tab group for this session (receives tabGroupId from client)
  // Skip tab grouping for MCP sessions with dedicated windows — chrome.tabs.group()
  // pulls tabs out of their window and into the main window's tab strip
  let sessionTabGroupId = initialTabGroupId;
  const hasDedicatedWindow = mcpSession && mcpSession.windowId;
  if (!hasDedicatedWindow) {
    const newGroupId = await ensureTabGroup(initialTabId, sessionTabGroupId);
    if (newGroupId !== sessionTabGroupId) {
      // Group was created or changed - notify client
      sessionTabGroupId = newGroupId;
      chrome.runtime.sendMessage({
        type: 'SESSION_GROUP_UPDATE',
        tabGroupId: sessionTabGroupId
      }).catch(() => {});
    }
  }

  // Get tab info for system-reminder — query ALL tabs in the session's window
  let tabInfo = { availableTabs: [], initialTabId, domainSkills: [] };
  let currentTabUrl = null; // Track current URL for tool filtering
  try {
    // For MCP sessions with a dedicated window, show all tabs in that window
    const windowId = mcpSession?.windowId;
    if (windowId) {
      const win = await chrome.windows.get(windowId, { populate: true });
      tabInfo.availableTabs = (win.tabs || [])
        .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('about:'))
        .map(t => ({ tabId: t.id, title: t.title || 'New Tab', url: t.url, active: t.active }));
      // Use the active tab's URL for domain skills, fallback to initialTabId
      const activeTab = (win.tabs || []).find(t => t.active);
      currentTabUrl = activeTab?.url || null;
    }

    // Fallback: if no window or no tabs found, use the initial tab directly
    if (tabInfo.availableTabs.length === 0) {
      const tab = await chrome.tabs.get(initialTabId);
      currentTabUrl = tab.url || null;
      tabInfo.availableTabs = [{
        tabId: initialTabId,
        title: tab.title || 'New Tab',
        url: tab.url || 'chrome://newtab/',
        active: tab.active,
      }];
    }

    // Add domain-specific skills for the current page
    if (currentTabUrl) {
      const skills = getDomainSkills(currentTabUrl, getConfig().userSkills || []);
      if (skills.length > 0) {
        tabInfo.domainSkills = skills.map(s => ({ domain: s.domain, skill: s.skill }));
        await taskLog('SKILLS', `Loaded ${skills.length} domain skill(s) for ${currentTabUrl}`, { domains: skills.map(s => s.domain) });
      }
    }
  } catch (e) {
    // Tab/window not accessible, use defaults
  }

  // Build new user message with optional images and system-reminders
  const userContent = [];

  // Add images first if present
  if (images && images.length > 0) {
    for (const image of images) {
      const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
      const mediaType = image.match(/^data:(image\/\w+);/)?.[1] || 'image/png';
      userContent.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } });
    }
  }

  // Add task text
  userContent.push({ type: 'text', text: task });

  // Add tab context as system-reminder
  userContent.push({
    type: 'text',
    text: `<system-reminder>${JSON.stringify(tabInfo)}</system-reminder>`,
  });

  // Add MCP task context if provided (for filling forms, making decisions)
  // This context contains information the agent needs to complete the task
  if (mcpSession?.context) {
    userContent.push({
      type: 'text',
      text: `<system-reminder>Task context (use this information when filling forms or making decisions):
${mcpSession.context}</system-reminder>`,
    });
    await taskLog('MCP', 'Task context injected', { contextLength: mcpSession.context.length });
  }

  // Add planning mode reminder if askBeforeActing is enabled AND this is a new conversation
  // IMPORTANT: Only add for Claude models - update_plan is Claude-specific and filtered out for other providers
  if (askBeforeActing && existingHistory.length === 0 && isClaudeProvider()) {
    userContent.push({
      type: 'text',
      text: '<system-reminder>You are in planning mode. Before executing any tools, you must first present a plan to the user using the update_plan tool. The plan should include: domains (list of domains you will visit) and approach (high-level steps you will take).</system-reminder>',
    });
  }

  // Continue from existing history or start fresh
  let messages = [...existingHistory, { role: 'user', content: userContent }];
  let steps = 0;
  // maxSteps: 0 means unlimited, otherwise use configured value or default to 100
  const configMaxSteps = getConfig().maxSteps;
  const maxSteps = configMaxSteps === 0 ? Infinity : (configMaxSteps || 100);

  // Track injected MCP messages (for mid-execution message injection)
  let mcpMessagesInjected = mcpSession ? mcpSession.messages.length : 0;

  while (steps < maxSteps) {
    // Check if this run was cancelled
    if (isRunCancelled()) {
      return { success: false, message: 'Task stopped by user', messages, steps };
    }

    // Check for new MCP messages at start of each turn (handles turns with no tool calls)
    if (mcpSession && mcpSession.messages.length > mcpMessagesInjected) {
      const newMessages = mcpSession.messages.slice(mcpMessagesInjected);
      mcpMessagesInjected = mcpSession.messages.length;

      await taskLog('MCP', `Injecting ${newMessages.length} follow-up message(s) from user (start of turn)`);

      // Build fresh tab context — query all tabs in the session's window
      let freshTabInfo = { availableTabs: [], initialTabId, domainSkills: [] };
      try {
        const windowId = mcpSession?.windowId;
        if (windowId) {
          const win = await chrome.windows.get(windowId, { populate: true });
          freshTabInfo.availableTabs = (win.tabs || [])
            .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('about:'))
            .map(t => ({ tabId: t.id, title: t.title || 'New Tab', url: t.url, active: t.active }));
        }
        if (freshTabInfo.availableTabs.length === 0) {
          const tab = await chrome.tabs.get(initialTabId);
          freshTabInfo.availableTabs = [{ tabId: initialTabId, title: tab.title || 'New Tab', url: tab.url || 'chrome://newtab/', active: tab.active }];
        }
      } catch {
        // Tab/window gone mid-execution — agent will discover via tabs_context
      }

      for (const msg of newMessages) {
        if (msg.role === 'user') {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: msg.content },
              { type: 'text', text: `<system-reminder>${JSON.stringify(freshTabInfo)}</system-reminder>` },
            ]
          });
          onUpdate({ step: steps, status: 'message', text: `[User follow-up]: ${msg.content}` });
        }
      }
    }

    steps++;
    onUpdate({ step: steps, status: 'thinking' });

    // Calculate token count for monitoring
    const currentTokens = calculateContextTokens(messages);
    const memStats = getMemoryStats(messages);
    await taskLog('MEMORY', `Turn ${steps}: ${memStats.totalMessages} messages (${currentTokens.toLocaleString()} tokens)`, {
      atThreshold: currentTokens >= 190000,
      toolUses: memStats.toolUseCount
    });

    // Stream text chunks to UI
    let streamedText = '';
    const onTextChunk = (chunk) => {
      streamedText += chunk;
      onUpdate({ step: steps, status: 'streaming', text: streamedText });
    };

    // Conversation compaction strategy
    // Triggers at 190K tokens, preserves last 3 screenshots + summary
    // MCP tasks pass a wrapped callLLM that uses the session-level automation default.
    const compactionLLM = mcpSession
      ? (msgs, onChunk, log, url, signal, opts) =>
          callLLM(msgs, onChunk, log, url, signal, { ...opts, configOverride: mcpSession.modelConfig })
      : callLLM;
    messages = await compactIfNeeded(messages, compactionLLM, taskLog);

    let response;
    try {
      const llmPromise = callLLM(
        messages,
        onTextChunk,
        taskLog,
        currentTabUrl,
        mcpSession?.abortController?.signal,
        mcpSession ? { configOverride: mcpSession.modelConfig } : {}
      );
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`LLM watchdog timeout after ${LLM_WATCHDOG_TIMEOUT_MS / 1000} seconds`));
        }, LLM_WATCHDOG_TIMEOUT_MS);
      });
      response = await Promise.race([llmPromise, timeoutPromise]);

      // Track token usage for cost analysis
      if (response.usage) {
        recordApiCall(response.usage, sessionId);
      }

      // Log AI's complete response including reasoning
      const textBlocks = response.content.filter(b => b.type === 'text');
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

      await taskLog('AI_RESPONSE', `Turn ${steps}: AI reasoning and tool choices`, {
        stopReason: response.stop_reason,
        textContent: textBlocks.map(b => b.text).join('\n'),
        toolCalls: toolUseBlocks.map(t => ({
          name: t.name,
          input: t.input
        }))
      });
    } catch (error) {
      // Handle abort gracefully
      if (error.name === 'AbortError' || isRunCancelled()) {
        return { success: false, message: 'Task stopped by user', messages, steps };
      }
      throw error; // Re-throw other errors
    }
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(b => b.type === 'tool_use');

    // Always send any text content as a message (even if there are also tool uses)
    const textBlock = response.content.find(b => b.type === 'text');
    if (textBlock) {
      onUpdate({ step: steps, status: 'message', text: textBlock.text });
    }

    if (toolUses.length === 0) {
      if (response.stop_reason === 'end_turn') {
        return { success: true, message: 'Task completed', messages, steps };
      }
      continue;
    }

    const toolResults = [];
    for (const toolUse of toolUses) {
      if (isRunCancelled()) {
        return { success: false, message: 'Task stopped by user', messages, steps };
      }

      onUpdate({ step: steps, status: 'executing', tool: toolUse.name, input: toolUse.input });

      const result = await executeTool(toolUse.name, toolUse.input, sessionTabGroupId, mcpSession, {
        askBeforeActing,
        planScopeId: getPlanScopeId(sessionId),
      });

      if (isRunCancelled()) {
        return { success: false, message: 'Task stopped by user', messages, steps };
      }

      // Log structured tool result
      const isScreenshot = result && result.base64Image;
      const isError = result?.error || (typeof result === 'string' && result.includes('Error:'));

      // For logging, strip base64 data from result object
      const safeResult = isScreenshot ? {
        output: result.output,
        imageId: result.imageId,
        imageFormat: result.imageFormat,
      } : result;

      await taskLog('TOOL_RESULT', `Result from ${toolUse.name}`, {
        tool: toolUse.name,
        toolUseId: toolUse.id,
        success: !isError,
        resultType: isScreenshot ? 'screenshot' : typeof result,
        // For screenshots, reference the file (use session screenshots length as counter)
        screenshot: isScreenshot ? `screenshot_${(mcpSession?.screenshots || uiSessionState.taskScreenshots).length + 1}.jpeg` : null,
        // For text results, include full content
        textResult: typeof result === 'string' ? result : null,
        // For object results (not screenshots), include structure without base64
        objectResult: typeof result === 'object' && !isScreenshot ? result : (isScreenshot ? safeResult : null),
        // Error info
        error: isError ? (typeof result === 'string' ? result : result.error) : null
      });

      // Check for cancellation
      if (result && result.cancelled) {
        return { success: false, message: result.message, messages, steps };
      }

      // Handle screenshot results
      // computer-tool uses cdpHelper.screenshot() which already handles DPR scaling
      // Returns { base64Image, imageId, imageFormat, output }
      // Note: scroll/scroll_to actions also return base64Image with an output message
      if (result && result.base64Image) {
        const mediaType = result.imageFormat === 'jpeg' ? 'image/jpeg' : 'image/png';
        await taskLog('SCREENSHOT_API', `Sending to API: ${result.base64Image.length} chars, format=${result.imageFormat}`);

        // Save screenshot for logging as separate file (use per-session storage for MCP tasks)
        const dataUrl = `data:${mediaType};base64,${result.base64Image}`;
        if (mcpSession) {
          mcpSession.screenshots.push(dataUrl);
        } else {
          uiSessionState.taskScreenshots.push(dataUrl);
        }

        // Store in capturedScreenshots map so view_screenshot tool can retrieve it
        if (result.imageId) {
          getCapturedScreenshots(sessionId).set(result.imageId, dataUrl);
        }

        // Include the actual output message if present (e.g., "Scrolled down by 5 ticks at (x, y)")
        // Fall back to generic screenshot message if no output
        const textMessage = result.output || (result.imageId ? `Screenshot captured (ID: ${result.imageId})` : 'Screenshot captured');
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: [
            { type: 'text', text: textMessage },
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: result.base64Image } },
          ],
        });
        onUpdate({ step: steps, status: 'executed', tool: toolUse.name, input: toolUse.input, result: textMessage.substring(0, 100) });
      } else {
        // Enhance error messages for better LLM understanding
        let content = typeof result === 'string' ? result : JSON.stringify(result);
        if (typeof result === 'string' && result.toLowerCase().includes('error')) {
          content = enhanceErrorMessage(result);
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: content,
        });
        onUpdate({
          step: steps,
          status: 'executed',
          tool: toolUse.name,
          input: toolUse.input,
          result: typeof result === 'string' ? result.substring(0, 200) : 'done',
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });

    // Check for new MCP messages injected during execution
    if (mcpSession && mcpSession.messages.length > mcpMessagesInjected) {
      const newMessages = mcpSession.messages.slice(mcpMessagesInjected);
      mcpMessagesInjected = mcpSession.messages.length;

      await taskLog('MCP', `Injecting ${newMessages.length} follow-up message(s) from user`);

      // Inject each new message as a user message
      for (const msg of newMessages) {
        if (msg.role === 'user') {
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: msg.content }]
          });
          onUpdate({ step: steps, status: 'message', text: `[User follow-up]: ${msg.content}` });
        }
      }
    }
  }

  return { success: false, message: `Reached max steps (${maxSteps})`, messages, steps };
}

// ============================================
// TASK MANAGEMENT
// ============================================

/**
 * Start a new agent task
 * @param {number} tabId - Tab ID to start the task in
 * @param {string} task - Natural language task description
 * @param {boolean} [shouldAskBeforeActing] - Whether to ask user before executing actions
 * @param {Array<string>} [images] - Array of base64 image data URLs to include
 * @param {number|null} [tabGroupId] - Optional tab group ID from client (UI manages this)
 * @returns {Promise<Object>} Task result with {success: boolean, message: string}
 */
async function startTask(tabId, task, shouldAskBeforeActing = true, images = [], tabGroupId = null) {
  // Reset state for new task (but preserve conversation history)
  // NOTE: tabGroupId is now passed from client, not stored globally
  agentOpenedTabs.clear();  // Clear tracked tabs from previous session
  activeSessions.add('ui-task');  // Mark UI session as active for popup tracking
  uiSessionState.cancelled = false;
  uiSessionState.taskScreenshots = [];
  taskDebugLog.length = 0; // Clear debug log for new task without breaking shared reference
  resetApiCallCounter(); // Reset API call counter for logging
  resetTaskUsage(); // Reset token usage for this task
  clearDebuggerSession();
  clearCapturedScreenshots();
  resolvePendingPlan('ui-task', { approved: false });
  registerDebuggerSession(tabId);

  // Create new abort controller for this task
  createAbortController();
  const startTime = new Date().toISOString();
  uiSessionState.currentTask = { tabId, task, status: 'running', steps: [], startTime };

  // Show visual indicator on the tab
  await showAgentIndicators(tabId);

  try {
    const result = await runAgentLoop(tabId, task, update => {
      uiSessionState.currentTask.steps.push(update);
      chrome.runtime.sendMessage({ type: 'TASK_UPDATE', update }).catch(() => {});
    }, images, shouldAskBeforeActing, uiSessionState.conversationHistory, tabGroupId);

    // Update conversation history with the full message history from this run
    if (result.messages) {
      uiSessionState.conversationHistory = result.messages;
    }

    await detachDebugger();
    activeSessions.delete('ui-task');  // Mark UI session as inactive
    uiSessionState.currentTask.status = result.success ? 'completed' : 'failed';
    uiSessionState.currentTask.result = result;
    uiSessionState.currentTask.endTime = new Date().toISOString();

    // Log API call summary
    const totalApiCalls = getApiCallCount();
    await log('TASK', `📈 TASK COMPLETE - Total API calls: ${totalApiCalls}`, {
      totalApiCalls,
      status: uiSessionState.currentTask.status,
      turns: result.steps || 0,
    });

    // Get task usage before recording completion
    const taskUsage = getTaskUsage();

    // Save clean task log with usage
    const logData = {
      task,
      status: uiSessionState.currentTask.status,
      startTime,
      endTime: uiSessionState.currentTask.endTime,
      messages: result.messages || [],
      usage: taskUsage,
      error: null,
    };
    await saveTaskLogs(logData, uiSessionState.taskScreenshots);

    // Hide visual indicators
    await hideAgentIndicators(tabId);

    // Record successful task completion for usage stats
    recordTaskCompletion(true);

    chrome.runtime.sendMessage({ type: 'TASK_COMPLETE', result }).catch(() => {});
    return result;
  } catch (error) {
    await detachDebugger();
    activeSessions.delete('ui-task');  // Mark UI session as inactive
    // Hide visual indicators
    await hideAgentIndicators(tabId);

    // Check if this was a user cancellation
    const isCancelled = error.name === 'AbortError' || uiSessionState.cancelled;

    uiSessionState.currentTask.status = isCancelled ? 'stopped' : 'error';
    uiSessionState.currentTask.error = error.message;
    uiSessionState.currentTask.endTime = new Date().toISOString();

    // Get task usage before recording completion
    const taskUsage = getTaskUsage();

    // Save log with conversation history (not empty)
    const logData = {
      task,
      status: uiSessionState.currentTask.status,
      startTime,
      endTime: uiSessionState.currentTask.endTime,
      messages: uiSessionState.conversationHistory || [],
      usage: taskUsage,
      error: isCancelled ? 'Stopped by user' : error.message,
    };
    await saveTaskLogs(logData, uiSessionState.taskScreenshots);

    // Record failed task completion for usage stats
    recordTaskCompletion(false);

    chrome.runtime.sendMessage({
      type: isCancelled ? 'TASK_COMPLETE' : 'TASK_ERROR',
      result: isCancelled ? { success: false, message: 'Task stopped by user' } : undefined,
      error: isCancelled ? undefined : error.message
    }).catch(() => {});

    if (!isCancelled) {
      throw error;
    }
  }
}

// ============================================
// MESSAGE HANDLER
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'START_TASK':
      checkAndIncrementUsage().then(usage => {
        if (!usage.allowed) {
          sendResponse({ success: false, error: usage.message });
          return;
        }
        startTask(
          payload.tabId,
          payload.task,
          payload.askBeforeActing !== false,
          payload.images || [],
          payload.tabGroupId || null
        )
          .then(result => sendResponse({ success: true, result }))
          .catch(error => sendResponse({ success: false, error: error.message }));
      });
      return true;

    case 'GET_STATUS':
      sendResponse({ task: uiSessionState.currentTask });
      return false;

    case 'SAVE_CONFIG':
      chrome.storage.local.set(payload).then(() => {
        setConfig(payload);
        sendResponse({ success: true });
      });
      return true;

    case 'GET_CONFIG':
      loadConfig().then(cfg => sendResponse(cfg));
      return true;

    case 'GET_LOG':
      chrome.storage.local.get(['agent_log']).then(data => {
        sendResponse({ log: data['agent_log'] || [] });
      });
      return true;

    case 'PLAN_APPROVAL_RESPONSE':
      resolvePendingPlan('ui-task', payload);
      sendResponse({ success: true });
      return false;

    case 'GET_LICENSE_STATUS':
      getLicenseStatus().then(status => sendResponse(status));
      return true;

    case 'ACTIVATE_LICENSE':
      activateLicense(payload.key).then(result => sendResponse(result));
      return true;

    case 'DEACTIVATE_LICENSE':
      deactivateLicense().then(result => sendResponse(result));
      return true;

    case 'MANAGED_PAIR': {
      // Exchange a pairing token for a managed session
      // Also captures the current active tab as the session's browser context
      const { pairing_token, api_url } = payload;
      const baseUrl = api_url || 'http://localhost:3456';
      (async () => {
        try {
          // Don't capture the current tab (which is likely the dashboard).
          // A dedicated tab will be created lazily on first tool execution in mcp-bridge.js.
          const capturedTabId = null;
          const capturedWindowId = null;

          const res = await fetch(`${baseUrl}/v1/browser-sessions/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pairing_token }),
          });
          const data = await res.json();

          if (data.session_token) {
            setManagedSession(data.session_token, data.browser_session_id, baseUrl);
            // Persist the captured tab as the session's owned context
            if (capturedTabId && data.browser_session_id) {
              const tabMap = (await chrome.storage.local.get('managed_session_tabs')).managed_session_tabs || {};
              tabMap[data.browser_session_id] = capturedTabId;
              await chrome.storage.local.set({ managed_session_tabs: tabMap });
            }
            sendResponse({ success: true, browserSessionId: data.browser_session_id });
          } else {
            sendResponse({ success: false, error: data.error || 'Pairing failed' });
          }
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'MANAGED_DISCONNECT':
      clearManagedSession();
      sendResponse({ success: true });
      return false;

    case 'GET_MANAGED_STATUS':
      getManagedSessionInfo().then(info => sendResponse(info));
      return true; // async

    case 'CLEAR_CONVERSATION':
      // Reset state for new conversation
      uiSessionState.currentTask = null;
      uiSessionState.conversationHistory = [];
      clearCapturedScreenshots();
      uiSessionState.taskScreenshots = [];
      clearDebuggerSession();
      resolvePendingPlan('ui-task', { approved: false });
      clearLog();
      sendResponse({ success: true });
      return false;

    case 'STOP_TASK':
      uiSessionState.cancelled = true;
      // Abort any ongoing API call
      abortRequest();
      // Also resolve any pending plan approval
      resolvePendingPlan('ui-task', { approved: false });
      sendResponse({ success: true });
      return false;

    case 'START_OAUTH_LOGIN':
      console.log('[ServiceWorker] START_OAUTH_LOGIN message received');
      console.log('[ServiceWorker] Calling startOAuthLogin()...');
      startOAuthLogin()
        .then(async tokens => {
          console.log('[ServiceWorker] ✓ OAuth login successful');
          console.log('[ServiceWorker] Reloading config to pick up authMethod...');
          await loadConfig();
          console.log('[ServiceWorker] Config reloaded, authMethod:', getConfig().authMethod);
          console.log('[ServiceWorker] Tokens received, sending response to sidepanel');
          sendResponse({ success: true, tokens });
        })
        .catch(error => {
          console.error('[ServiceWorker] ✗ OAuth login failed:', error);
          console.error('[ServiceWorker] Error message:', error.message);
          console.error('[ServiceWorker] Error stack:', error.stack);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'OAUTH_LOGOUT':
      console.log('[ServiceWorker] OAUTH_LOGOUT message received');
      logout().then(async () => {
        console.log('[ServiceWorker] ✓ OAuth logout complete');
        console.log('[ServiceWorker] Reloading config to clear authMethod...');
        await loadConfig();
        console.log('[ServiceWorker] Config reloaded');
        sendResponse({ success: true });
      });
      return true;

    case 'GET_OAUTH_STATUS':
      console.log('[ServiceWorker] GET_OAUTH_STATUS message received');
      getAuthStatus().then(status => {
        console.log('[ServiceWorker] OAuth status:', status);
        sendResponse(status);
      });
      return true;

    case 'IMPORT_CLI_CREDENTIALS':
      console.log('[ServiceWorker] IMPORT_CLI_CREDENTIALS message received');
      console.log('[ServiceWorker] Calling importCLICredentials()...');
      importCLICredentials()
        .then(async credentials => {
          console.log('[ServiceWorker] ✓ CLI credentials import successful');
          console.log('[ServiceWorker] Reloading config to pick up authMethod...');
          await loadConfig();
          console.log('[ServiceWorker] Config reloaded, authMethod:', getConfig().authMethod);
          console.log('[ServiceWorker] Credentials received, sending response to sidepanel');
          sendResponse({ success: true, credentials });
        })
        .catch(error => {
          console.error('[ServiceWorker] ✗ CLI credentials import failed:', error);
          console.error('[ServiceWorker] Error message:', error.message);
          console.error('[ServiceWorker] Error stack:', error.stack);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'CLEAR_CHAT':
      // Clear conversation history for new chat session
      uiSessionState.conversationHistory = [];
      sendResponse({ success: true });
      return false;

    case 'IMPORT_CODEX_CREDENTIALS':
      console.log('[ServiceWorker] IMPORT_CODEX_CREDENTIALS message received');
      console.log('[ServiceWorker] Calling importCodexCredentials()...');
      importCodexCredentials()
        .then(async credentials => {
          console.log('[ServiceWorker] ✓ Codex credentials import successful');
          console.log('[ServiceWorker] Reloading config...');
          await loadConfig();
          console.log('[ServiceWorker] Credentials received, sending response to sidepanel');
          sendResponse({ success: true, credentials });
        })
        .catch(error => {
          console.error('[ServiceWorker] ✗ Codex credentials import failed:', error);
          console.error('[ServiceWorker] Error message:', error.message);
          sendResponse({ success: false, error: error.message });
        });
      return true;

    case 'CODEX_LOGOUT':
      console.log('[ServiceWorker] CODEX_LOGOUT message received');
      logoutCodex().then(async () => {
        console.log('[ServiceWorker] ✓ Codex logout complete');
        await loadConfig();
        sendResponse({ success: true });
      });
      return true;

    case 'GET_CODEX_STATUS':
      console.log('[ServiceWorker] GET_CODEX_STATUS message received');
      getCodexAuthStatus().then(status => {
        console.log('[ServiceWorker] Codex status:', status);
        sendResponse(status);
      });
      return true;
  }
});

// Open status page on first install
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // Check if credentials already exist (e.g. user ran CLI setup first)
    const config = await chrome.storage.local.get(['providerKeys', 'customModels']);
    const hasKeys = Object.values(config.providerKeys || {}).some(k => !!k);
    const hasCustom = (config.customModels || []).length > 0;
    const alreadyConfigured = hasKeys || hasCustom;

    await chrome.storage.local.set({
      onboarding_completed: alreadyConfigured,
      onboarding_version: 2,
    });
    chrome.tabs.create({ url: chrome.runtime.getURL('dist/onboarding.html') });
  }
});

// Open side panel when clicking the extension icon
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

// Set side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ============================================
// MCP BRIDGE INTEGRATION
// ============================================

// mcpSessions is defined at top of file (needed early for popup callbacks)

// Session cleanup interval (clean up idle sessions older than 1 hour)
// IMPORTANT: Only clean up sessions that are NOT currently running.
// Running sessions may execute for a long time — cleaning them mid-execution
// causes data loss and orphaned browser windows.
const MCP_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of mcpSessions) {
    // Never clean up a running session
    if (session.status === 'running') continue;
    // Use lastActivityAt if available, otherwise fall back to createdAt
    const lastActive = session.lastActivityAt || session.createdAt;
    if (now - lastActive > MCP_SESSION_TTL_MS) {
      console.log(`[MCP] Cleaning up idle session: ${sessionId} (idle since ${new Date(lastActive).toISOString()})`);
      resolvePendingPlan(sessionId, { approved: false });
      unregisterTaskLogging(sessionId);
      unregisterDebuggerSession(sessionId);
      removeCapturedScreenshots(sessionId);
      mcpSessions.delete(sessionId);
      void persistMcpSessions();
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

/**
 * Start a task from MCP server
 * @param {string} sessionId - Unique session identifier
 * @param {string} task - Task description
 * @param {string} [url] - Optional starting URL
 * @param {string} [context] - Optional task context (info needed to complete the task)
 */
async function handleMcpStartTask(sessionId, task, url, context, licenseKey) {
  console.log(`[MCP] Starting task: ${sessionId}`, { task, url, hasContext: !!context });

  // Idempotency guard: if this session already exists and is running,
  // ignore the duplicate start (relay queue replay, reconnect race, etc.)
  const existingSession = mcpSessions.get(sessionId);
  if (existingSession && (existingSession.status === 'running' || existingSession.status === 'starting')) {
    console.warn(`[MCP] Ignoring duplicate start for already-active session ${sessionId} (status: ${existingSession.status})`);
    return;
  }

  try {
    await loadConfig();
    const agentModelConfig = resolveAgentDefaultConfig(getConfig());

    // Auto-activate license key if passed from MCP server (env var path)
    if (licenseKey) {
      const existing = await getLicenseStatus();
      if (!existing.isPro) {
        const activation = await activateLicense(licenseKey);
        console.log(`[MCP] License auto-activation: ${activation.message}`);
      }
    }

    // Check license / daily usage limit
    const usage = await checkAndIncrementUsage();
    if (!usage.allowed) {
      sendMcpError(sessionId, usage.message);
      return;
    }
    console.log(`[MCP] Usage: ${usage.message}`);

    // Check concurrent task window limit
    const activeTaskWindows = Array.from(mcpSessions.values())
      .filter(s => s.windowId && s.status === 'running')
      .length;

    if (activeTaskWindows >= MAX_CONCURRENT_TASK_WINDOWS) {
      sendMcpError(sessionId, `Max concurrent tasks (${MAX_CONCURRENT_TASK_WINDOWS}) reached. Wait for a task to complete or stop one.`);
      return;
    }

    // Create a dedicated window for this task (enables true parallel execution)
    let tabId;
    let windowId;

    // Create new window - each task gets isolation
    const startUrl = url || 'about:blank';
    const window = await chrome.windows.create({
      url: startUrl,
      type: 'normal',
      focused: false,  // Don't steal focus from user's current work
      state: 'normal'
    });
    windowId = window.id;
    tabId = window.tabs[0].id;
    console.log(`[MCP] Created task window ${windowId} with tab ${tabId} for session ${sessionId}`);

    // Wait for page to load if URL was provided
    if (url) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Create session with per-session state (enables parallel execution)
    mcpSessions.set(sessionId, {
      sessionId,          // Store sessionId for Mem0 lookup
      tabId,
      windowId,           // Track window for cleanup
      url,
      task,
      context,            // Task context for memory/info lookup
      messages: [],       // Per-session chat history
      status: 'running',
      cancelled: false,   // Per-session cancellation flag
      cancelReason: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(), // Updated on status changes; used by TTL cleanup
      // Per-session state for parallel execution:
      screenshots: [],    // Screenshots collected during this task
      debugLog: [],       // Debug log for this task
      steps: [],          // Task steps
      openedTabs: new Set(), // Tabs opened by this session
      tabStack: [],       // Stack for popup navigation (push when popup opens, pop when closes)
      startTime: new Date().toISOString(),
      abortController: new AbortController(), // Per-session abort controller
      modelConfig: agentModelConfig,
    });

    // Start the task WITHOUT awaiting - enables parallel execution
    // Error handling is done inside startMcpTaskInternal
    // Track the run promise so follow-ups can wait for cleanup before re-starting
    const session = mcpSessions.get(sessionId);
    void persistMcpSessions();
    session.runPromise = startMcpTaskInternal(sessionId, tabId, task).catch(error => {
      console.error(`[MCP] Task execution error:`, error);
      sendMcpError(sessionId, error.message);
    });
  } catch (error) {
    console.error(`[MCP] Task start error:`, error);
    sendMcpError(sessionId, error.message);
  }
}

/**
 * Internal MCP task execution
 */
async function startMcpTaskInternal(sessionId, tabId, task) {
  const session = mcpSessions.get(sessionId);
  if (!session) {
    console.error(`[MCP] Session not found: ${sessionId}`);
    return;
  }

  if (!session.modelConfig) {
    await loadConfig();
    session.modelConfig = resolveAgentDefaultConfig(getConfig());
  }

  const taskLog = (type, message, data = null) => log(type, message, data, { sessionId });

  // Mark this session as active (enables parallel execution tracking)
  activeSessions.add(sessionId);

  // Per-session state is already initialized in handleMcpStartTask
  // Note: We use session.abortController for per-session cancellation (parallel execution)
  registerDebuggerSession(tabId, sessionId);
  clearDebuggerSession(sessionId);
  clearCapturedScreenshots(sessionId);
  resolvePendingPlan(sessionId, { approved: false });

  // Reset per-run session state while preserving conversation history
  session.startTime = new Date().toISOString();
  session.endTime = null;
  session.result = null;
  session.steps.length = 0;
  session.cancelled = false;
  session.cancelReason = null;
  session.debugLog.length = 0;
  session.screenshots = [];
  registerTaskLogging(sessionId, session.debugLog);
  resetTaskUsage(sessionId);
  void persistMcpSessions();

  try {
    await showAgentIndicators(tabId);
  } catch (indicatorErr) {
    console.warn(`[MCP] showAgentIndicators failed (non-fatal):`, indicatorErr.message);
  }

  await taskLog('MCP', `Starting task: ${sessionId}`, { task, tabId, hasHistory: (session.messages?.length || 0) > 0 });

  try {
    // Use per-session messages instead of global conversationHistory
    const result = await runAgentLoop(tabId, task, update => {
      if (session.cancelled && session.cancelReason === 'stopped') {
        return;
      }

      session.steps.push(update);

      // Log meaningful updates only (skip streaming chunks - they're redundant with AI_RESPONSE)
      if (update.status !== 'streaming' && update.status !== 'message') {
        taskLog('MCP', `Task update: ${update.status}`, {
          sessionId,
          step: session.steps.length,
          tool: update.tool,
          text: update.text?.substring(0, 100)
        });
      }

      // Send update to MCP server with informative step descriptions
      // Debug: log to verify sessionId
      console.log('[SW Debug] Sending MCP update:', { sessionId, status: update.status, tool: update.tool });

      if ((update.status === 'executing' || update.status === 'executed') && update.tool) {
        // Format: "Using read_page" or "Using computer: click at (100, 200)"
        let toolDesc = update.tool;
        if (update.status === 'executing') {
          // Include input details for more context
          if (update.input?.action) {
            toolDesc = `${update.tool}: ${update.input.action}`;
            if (update.input.coordinate) {
              toolDesc += ` at (${update.input.coordinate[0]}, ${update.input.coordinate[1]})`;
            }
          } else if (update.input?.selector) {
            toolDesc = `${update.tool}: ${update.input.selector.substring(0, 40)}`;
          } else if (update.input?.url) {
            toolDesc = `${update.tool}: ${update.input.url.substring(0, 50)}`;
          } else if (update.input?.text) {
            toolDesc = `${update.tool}: "${update.input.text.substring(0, 30)}"`;
          }
          sendMcpUpdate(sessionId, 'running', `[browser_agent:${update.tool}] ${toolDesc}`);
        } else if (update.status === 'executed' && update.result) {
          sendMcpUpdate(sessionId, 'running', `[browser_agent:${update.tool}] Done: ${update.result.substring(0, 80)}`);
        }
      } else if (update.status === 'thinking') {
        sendMcpUpdate(sessionId, 'running', '[browser_agent:thinking]');
      } else if (update.status === 'message') {
        sendMcpUpdate(sessionId, 'running', `[browser_agent:message] ${update.text}`);
      }
    }, [], false, session.messages, null, session);

    // Store messages back in session (per-session history)
    if (result.messages) {
      session.messages = result.messages;
    }
    session.status = result.success ? 'complete' : 'error';
    session.result = result;
    session.endTime = new Date().toISOString();
    session.lastActivityAt = Date.now();
    void persistMcpSessions();
    // Don't delete session - keep it for continuation

    await detachDebugger(tabId);  // Only detach this tab (parallel execution)
    activeSessions.delete(sessionId);  // Mark this session as inactive

    await hideAgentIndicators(tabId);

    // Get task usage before recording completion
    const taskUsage = getTaskUsage(sessionId);

    // Save MCP task logs (use per-session screenshots)
    const logData = {
      task: `[MCP:${sessionId}] ${task}`,
      sessionId,
      status: result.success ? 'completed' : 'failed',
      startTime: session.startTime,
      endTime: session.endTime,
      messages: result.messages || [],
      usage: taskUsage,
      error: null,
    };
    await saveTaskLogs(logData, session.screenshots, { sessionId });

    // Record task completion for usage stats
    recordTaskCompletion(result.success);

    // Send completion to MCP server — but NOT if session was cancelled/superseded
    // (e.g., a follow-up message arrived and is waiting for this loop to finish)
    if (!session.cancelled) {
      sendMcpComplete(sessionId, {
        success: result.success,
        message: result.message,
        steps: session.steps.length
      });
    }

    // Leave task window open so user can review the result

  } catch (error) {
    await detachDebugger(tabId);  // Only detach this tab (parallel execution)
    activeSessions.delete(sessionId);  // Mark this session as inactive
    await hideAgentIndicators(tabId);

    // Update session status but don't delete
    session.status = 'error';

    const isCancelled = error.name === 'AbortError' || session.cancelled;
    const errorMessage = isCancelled ? 'Stopped by user' : error.message;

    if (isCancelled) {
      session.status = 'stopped';
    }
    session.endTime = new Date().toISOString();
    session.lastActivityAt = Date.now();
    void persistMcpSessions();

    // Log error FIRST (before saveTaskLogs) so it appears in the debug log
    await taskLog('ERROR', `[MCP] Task failed: ${errorMessage}`, { sessionId, error: error.stack });
    console.error(`[MCP] startMcpTaskInternal error:`, error);

    // Get task usage before recording completion
    const taskUsage = getTaskUsage(sessionId);

    // Save MCP task error logs (use per-session data)
    const logData = {
      task: `[MCP:${sessionId}] ${task}`,
      sessionId,
      status: isCancelled ? 'stopped' : 'error',
      startTime: session.startTime,
      endTime: session.endTime,
      messages: session.messages || [],
      usage: taskUsage,
      error: errorMessage,
    };
    await saveTaskLogs(logData, session.screenshots, { sessionId });

    // Record failed task for usage stats
    recordTaskCompletion(false);

    // For follow-up supersession, suppress terminal updates from the old run.
    if (session.cancelReason !== 'superseded') {
      if (isCancelled) {
        sendMcpComplete(sessionId, { success: false, message: 'Task stopped by user' });
      } else {
        sendMcpError(sessionId, error.message);
      }
    }

    // Leave task window open so user can review the error state
  }
}

// Per-session locks to prevent concurrent follow-up message handling.
// Without this, two follow-ups arriving simultaneously for a non-running session
// both pass the status check, both await the same runPromise, both reset state,
// and both start new agent loops — causing two concurrent loops on one session.
const sessionFollowUpLocks = new Map(); // sessionId → Promise

/**
 * Send follow-up message to MCP task (works on running, complete, or stopped sessions)
 */
async function handleMcpSendMessage(sessionId, message) {
  // Serialize follow-up handling per session to prevent concurrent re-activation.
  // IMPORTANT: Set the lock BEFORE checking for an existing one. This prevents
  // a TOCTOU race where two calls both find no lock and both proceed.
  let releaseLock;
  const lockPromise = new Promise(resolve => { releaseLock = resolve; });
  const existingLock = sessionFollowUpLocks.get(sessionId);
  sessionFollowUpLocks.set(sessionId, lockPromise); // Atomically claim the lock

  if (existingLock) {
    console.log(`[MCP] Waiting for existing follow-up lock on session ${sessionId}`);
    await existingLock;
  }

  try {
    await _handleMcpSendMessageInner(sessionId, message);
  } finally {
    // Only delete if we're still the current lock holder (another call may have replaced us)
    if (sessionFollowUpLocks.get(sessionId) === lockPromise) {
      sessionFollowUpLocks.delete(sessionId);
    }
    releaseLock();
  }
}

async function _handleMcpSendMessageInner(sessionId, message) {
  console.log(`[MCP] Follow-up message for ${sessionId}:`, message);

  const session = mcpSessions.get(sessionId);
  if (!session) {
    console.warn(`[MCP] Session not found: ${sessionId}`);
    sendMcpError(sessionId, 'Session not found');
    return;
  }

  // If session is complete/stopped/error, re-run the agent with the new message
  if (session.status !== 'running') {
    console.log(`[MCP] Re-activating session ${sessionId} (was: ${session.status})`);

    // CRITICAL: Wait for the previous agent loop to fully finish before starting a new one.
    // Without this, two loops can run concurrently on the same session — the old loop's
    // cleanup (detach debugger, set status='error', send completion) destroys the new loop's state.
    // This race condition is the root cause of follow-up messages failing with multiple tabs.
    session.cancelled = true;  // Signal old loop to exit
    session.cancelReason = 'superseded';
    if (session.abortController) session.abortController.abort();  // Abort in-progress LLM call
    if (session.runPromise) {
      console.log(`[MCP] Waiting for previous run to finish for session ${sessionId}...`);
      await session.runPromise;
      console.log(`[MCP] Previous run finished for session ${sessionId}`);
    }

    // Now safe to reset and start fresh — old loop is fully done
    session.status = 'running';
    session.cancelled = false;
    session.cancelReason = null;
    session.abortController = new AbortController();
    session.lastActivityAt = Date.now();
    void persistMcpSessions();

    // DON'T push to session.messages here — runAgentLoop will add it with
    // proper tab context. Pushing here would create a duplicate message.

    // Validate tab still exists before re-running — tab may have been closed
    // Prefer the ACTIVE tab in the session's window (user may have navigated)
    let tabId = session.tabId;
    try {
      // First try to get the active tab in the session's window
      if (session.windowId) {
        const win = await chrome.windows.get(session.windowId, { populate: true });
        const activeTab = (win.tabs || []).find(t => t.active && t.url && !t.url.startsWith('chrome://'));
        if (activeTab) {
          tabId = activeTab.id;
          session.tabId = tabId;
        }
      }
      await chrome.tabs.get(tabId);
    } catch {
      // Tab is gone — find a valid tab from the session's window
      console.log(`[MCP] Tab ${tabId} no longer exists, recovering...`);
      tabId = await recoverSessionTab(session);
      if (tabId) {
        session.tabId = tabId;
        console.log(`[MCP] Recovered to tab ${tabId}`);
      } else {
        sendMcpError(sessionId, 'Session tab and window are both gone. Start a new session.');
        session.status = 'error';
        return;
      }
    }

    // Re-run the agent with the validated tab — track the promise for future follow-ups
    session.runPromise = startMcpTaskInternal(sessionId, tabId, message).catch(error => {
      console.error(`[MCP] Follow-up execution error:`, error);
      session.status = 'error';
      sendMcpError(sessionId, error.message);
    });
  } else {
    // Session is still running — append to session.messages for mid-execution injection
    session.messages.push({
      role: 'user',
      content: message
    });
    session.lastActivityAt = Date.now(); // Prevent TTL cleanup during active message injection
    void persistMcpSessions();
    sendMcpUpdate(sessionId, 'running', 'Message received, continuing...');
  }
}

/**
 * Recover a valid tab for a session whose original tab was closed.
 * Tries: active tab in session window → any tab in session window → new tab.
 * @returns {number|null} Valid tab ID or null if unrecoverable
 */
async function recoverSessionTab(session) {
  // Try to find a tab in the session's window
  if (session.windowId) {
    try {
      const win = await chrome.windows.get(session.windowId, { populate: true });
      if (win.tabs && win.tabs.length > 0) {
        // Prefer an accessible active tab, then any accessible tab, then any tab
        const activeAccessible = win.tabs.find(t => t.active && isAccessibleTab(t));
        if (activeAccessible) return activeAccessible.id;
        const anyAccessible = win.tabs.find(t => isAccessibleTab(t));
        if (anyAccessible) return anyAccessible.id;
        // Only restricted tabs left — return one anyway so navigate can fix it
        return (win.tabs.find(t => t.active) || win.tabs[0]).id;
      }
    } catch {
      // Window is also gone
      console.log(`[MCP] Window ${session.windowId} also gone`);
    }
  }

  // Window gone — create a new one with the session's URL if available
  try {
    const url = session.url || undefined; // undefined lets Chrome open the default new tab
    const win = await chrome.windows.create({ url, focused: true });
    session.windowId = win.id;
    return win.tabs[0].id;
  } catch (e) {
    console.error(`[MCP] Failed to create recovery window:`, e);
    return null;
  }
}

/**
 * Stop an MCP task
 */
async function handleMcpStopTask(sessionId, remove = false) {
  console.log(`[MCP] Stopping task: ${sessionId}, remove: ${remove}`);

  const session = mcpSessions.get(sessionId);
  if (!session) {
    console.warn(`[MCP] Session not found: ${sessionId}`);
    sendMcpError(sessionId, 'Session not found');
    return;
  }

  session.cancelled = true;  // Per-session cancellation
  session.cancelReason = 'stopped';
  activeSessions.delete(sessionId);  // Remove from active sessions

  // Abort this session's requests using per-session abort controller
  if (session.abortController) {
    session.abortController.abort();
  }

  resolvePendingPlan(sessionId, { approved: false });

  if (remove) {
    // Clean up task window before removing session
    if (session.windowId) {
      try {
        await chrome.windows.remove(session.windowId);
        console.log(`[MCP] Closed task window ${session.windowId} for session ${sessionId}`);
      } catch (e) {
        // Window may have been closed manually by user
        console.log(`[MCP] Window ${session.windowId} already closed`);
      }
    }
    // Delete session completely - chat history gone
    console.log(`[MCP] Removing session: ${sessionId}`);
    unregisterTaskLogging(sessionId);
    unregisterDebuggerSession(sessionId);
    removeCapturedScreenshots(sessionId);
    mcpSessions.delete(sessionId);
    void persistMcpSessions();
  } else {
    // Just pause - preserve chat history for resume
    session.status = 'stopped';
    session.lastActivityAt = Date.now();
    void persistMcpSessions();
  }
}

/**
 * Take screenshot for MCP session
 */
async function handleMcpScreenshot(sessionId) {
  console.log(`[MCP] Screenshot request for session: ${sessionId}`);

  try {
    let tabId;

    if (sessionId && mcpSessions.has(sessionId)) {
      tabId = mcpSessions.get(sessionId).tabId;
    } else {
      // Use current active tab
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) {
        console.warn('[MCP] No active tab for screenshot');
        return;
      }
      tabId = activeTab.id;
    }

    await ensureDebugger(tabId, sessionId || null);
    const screenshot = await sendDebuggerCommand(tabId, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality: 70
    });

    sendMcpScreenshot(sessionId, screenshot.data);
  } catch (error) {
    console.error('[MCP] Screenshot error:', error);
  }
}

// Initialize MCP bridge with callbacks
initMcpBridge({
  onStartTask: handleMcpStartTask,
  onSendMessage: handleMcpSendMessage,
  onStopTask: handleMcpStopTask,
  onScreenshot: handleMcpScreenshot,
});

void restoreMcpSessions();

// Start usage tracking session
startSession();

console.log('[Hanzi in Chrome] Service worker loaded');
console.log('[Hanzi in Chrome] MCP bridge initialized');
