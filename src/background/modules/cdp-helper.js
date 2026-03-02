/**
 * CDPHelper - Chrome DevTools Protocol Helper
 * Handles all browser automation via CDP: clicks, typing, screenshots, console/network monitoring
 *
 * Anti-Bot Features:
 * When antiBot=true, actions simulate human-like behavior:
 * - Typing: Random delays between characters (50-150ms with variance)
 * - Clicking: Bezier curve mouse movement to target, optional overshoot
 * - Scrolling: Momentum-based, variable speed
 */

import { KEY_DEFINITIONS } from './key-definitions.js';
import { MAC_COMMANDS } from './mac-commands.js';
import { screenshotContextManager } from './screenshot-context.js';
import { indicatorManager } from '../managers/indicator-manager.js';

// ============================================================================
// ANTI-BOT CONFIGURATION
// ============================================================================

const ANTI_BOT_CONFIG = {
  typing: {
    baseDelayMs: 80,        // Base delay between characters
    varianceMs: 40,         // Random variance ±40ms (so 40-120ms range)
    punctuationPauseMs: 150, // Extra pause after punctuation
    wordPauseMs: 100,       // Extra pause after space (between words)
  },
  mouse: {
    movementSteps: 25,      // Number of points in Bezier curve
    movementDurationMs: 300, // Total time for mouse movement
    overshootRadius: 15,    // Pixels to overshoot target
    overshootChance: 0.3,   // 30% chance to overshoot
    preClickDelayMs: 50,    // Pause before clicking after movement
    clickHoldMs: 80,        // Time between mousedown and mouseup
    clickHoldVariance: 30,  // Variance for click hold
  },
  scroll: {
    stepCount: 5,           // Number of scroll steps
    stepDelayMs: 50,        // Delay between scroll steps
    stepVariance: 20,       // Variance in delay
  },
  general: {
    preActionDelayMs: 100,  // Random pause before any action
    preActionVariance: 50,  // Variance for pre-action delay
  },
};

// ============================================================================
// ANTI-BOT HELPER FUNCTIONS
// ============================================================================

/**
 * Generate a random delay with variance
 * @param {number} base - Base delay in ms
 * @param {number} variance - Variance in ms (±variance)
 * @returns {number} Random delay
 */
function randomDelay(base, variance = 0) {
  return Math.max(0, base + (Math.random() * 2 - 1) * variance);
}

/**
 * Sleep for a random duration
 * @param {number} base - Base delay in ms
 * @param {number} variance - Variance in ms
 */
async function humanDelay(base, variance = 0) {
  const delay = randomDelay(base, variance);
  if (delay > 0) {
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

/**
 * Generate a cubic Bezier curve path between two points
 * Uses random control points for natural-looking movement
 *
 * @param {number} startX - Start X coordinate
 * @param {number} startY - Start Y coordinate
 * @param {number} endX - End X coordinate
 * @param {number} endY - End Y coordinate
 * @param {number} steps - Number of points to generate
 * @returns {Array<{x: number, y: number}>} Array of points along the curve
 */
function generateBezierPath(startX, startY, endX, endY, steps = 25) {
  // Calculate distance and direction
  const dx = endX - startX;
  const dy = endY - startY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Generate random control points perpendicular to the line
  // This creates a natural curved path
  const spread = Math.min(distance * 0.3, 100); // Curve spread, max 100px
  const perpX = -dy / (distance || 1); // Perpendicular direction
  const perpY = dx / (distance || 1);

  // Random offset for control points (same side for smooth curve)
  const side = Math.random() > 0.5 ? 1 : -1;
  const offset1 = (Math.random() * 0.5 + 0.25) * spread * side;
  const offset2 = (Math.random() * 0.5 + 0.25) * spread * side;

  // Control points at ~33% and ~66% along the path
  const cp1x = startX + dx * 0.33 + perpX * offset1;
  const cp1y = startY + dy * 0.33 + perpY * offset1;
  const cp2x = startX + dx * 0.66 + perpX * offset2;
  const cp2y = startY + dy * 0.66 + perpY * offset2;

  // Generate points along the cubic Bezier curve
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;

    // Cubic Bezier formula: B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
    const x = mt3 * startX + 3 * mt2 * t * cp1x + 3 * mt * t2 * cp2x + t3 * endX;
    const y = mt3 * startY + 3 * mt2 * t * cp1y + 3 * mt * t2 * cp2y + t3 * endY;

    points.push({ x: Math.round(x), y: Math.round(y) });
  }

  return points;
}

/**
 * Calculate overshoot position (slightly past the target)
 * @param {number} targetX - Target X coordinate
 * @param {number} targetY - Target Y coordinate
 * @param {number} radius - Max overshoot radius in pixels
 * @returns {{x: number, y: number}} Overshoot position
 */
function calculateOvershoot(targetX, targetY, radius) {
  const angle = Math.random() * 2 * Math.PI;
  const r = radius * Math.sqrt(Math.random()); // sqrt for uniform distribution in circle
  return {
    x: Math.round(targetX + r * Math.cos(angle)),
    y: Math.round(targetY + r * Math.sin(angle)),
  };
}

// ============================================================================
// GLOBAL STATE INITIALIZATION
// ============================================================================

if (!globalThis.__cdpDebuggerListenerRegistered) {
  globalThis.__cdpDebuggerListenerRegistered = false;
}

if (!globalThis.__cdpConsoleMessagesByTab) {
  globalThis.__cdpConsoleMessagesByTab = new Map();
}

if (!globalThis.__cdpNetworkRequestsByTab) {
  globalThis.__cdpNetworkRequestsByTab = new Map();
}

if (!globalThis.__cdpNetworkTrackingEnabled) {
  globalThis.__cdpNetworkTrackingEnabled = new Set();
}

if (!globalThis.__cdpConsoleTrackingEnabled) {
  globalThis.__cdpConsoleTrackingEnabled = new Set();
}

// ============================================================================
// CDP HELPER CLASS
// ============================================================================

class CDPHelper {
  // Static constants (lines 4899-4900, 5028-5031)
  static MAX_LOGS_PER_TAB = 10000;
  static MAX_REQUESTS_PER_TAB = 1000;
  static MAX_BASE64_CHARS = 1398100;
  static INITIAL_JPEG_QUALITY = 0.6;
  static JPEG_QUALITY_STEP = 0.05;
  static MIN_JPEG_QUALITY = 0.1;

  // Static getters/setters for global state (lines 4901-4918)
  static get debuggerListenerRegistered() {
    return globalThis.__cdpDebuggerListenerRegistered;
  }
  static set debuggerListenerRegistered(value) {
    globalThis.__cdpDebuggerListenerRegistered = value;
  }
  static get consoleMessagesByTab() {
    return globalThis.__cdpConsoleMessagesByTab;
  }
  static get networkRequestsByTab() {
    return globalThis.__cdpNetworkRequestsByTab;
  }
  static get networkTrackingEnabled() {
    return globalThis.__cdpNetworkTrackingEnabled;
  }
  static get consoleTrackingEnabled() {
    return globalThis.__cdpConsoleTrackingEnabled;
  }

  // Instance properties (lines 4919, 5023-5027)
  isMac = false;
  defaultResizeParams = {
    pxPerToken: 28,
    maxTargetPx: 1024,
    maxTargetTokens: 768,
  };

  // Constructor (lines 4920-4926)
  constructor() {
    this.isMac =
      navigator.platform.toUpperCase().includes("MAC") ||
      navigator.userAgent.toUpperCase().includes("MAC");

    this.initializeDebuggerEventListener();
  }

  // ============================================================================
  // DEBUGGER EVENT HANDLING (lines 4927-5021)
  // ============================================================================

  registerDebuggerEventHandlers() {
    if (!globalThis.__cdpDebuggerEventHandler) {
      globalThis.__cdpDebuggerEventHandler = (debuggee, method, params) => {
        const tabId = debuggee.tabId;
        if (tabId) {
          // Console API called (lines 4932-4948)
          if (method === "Runtime.consoleAPICalled") {
            const message = {
              type: params.type || "log",
              text: params.args
                ?.map((arg) =>
                  arg.value !== undefined ? String(arg.value) : arg.description || ""
                )
                .join(" "),
              timestamp: params.timestamp || Date.now(),
              url: params.stackTrace?.callFrames?.[0]?.url,
              lineNumber: params.stackTrace?.callFrames?.[0]?.lineNumber,
              columnNumber: params.stackTrace?.callFrames?.[0]?.columnNumber,
              args: params.args,
            };

            const domain = this.extractDomain(message.url);
            this.addConsoleMessage(tabId, domain, message);
          }

          // Exception thrown (lines 4950-4974)
          if (method === "Runtime.exceptionThrown") {
            const exceptionDetails = params.exceptionDetails;

            const message = {
              type: "exception",
              text:
                exceptionDetails?.exception?.description ||
                exceptionDetails?.text ||
                "Unknown exception",
              timestamp: exceptionDetails?.timestamp || Date.now(),
              url: exceptionDetails?.url,
              lineNumber: exceptionDetails?.lineNumber,
              columnNumber: exceptionDetails?.columnNumber,
              stackTrace: exceptionDetails?.stackTrace?.callFrames
                ?.map(
                  (frame) =>
                    `    at ${frame.functionName || "<anonymous>"} (${frame.url}:${
                      frame.lineNumber
                    }:${frame.columnNumber})`
                )
                .join("\n"),
            };

            const domain = this.extractDomain(message.url);
            this.addConsoleMessage(tabId, domain, message);
          }

          // Network request will be sent (lines 4976-4986)
          if (method === "Network.requestWillBeSent") {
            const { requestId, request, documentURL } = params;

            const requestInfo = {
              requestId: requestId,
              url: request.url,
              method: request.method,
            };
            const sourceUrl = documentURL || request.url;
            const domain = this.extractDomain(sourceUrl);
            this.addNetworkRequest(tabId, domain, requestInfo);
          }

          // Network response received (lines 4988-4998)
          if (method === "Network.responseReceived") {
            const { requestId, response } = params;

            const tabData = CDPHelper.networkRequestsByTab.get(tabId);
            if (tabData) {
              const request = tabData.requests.find((r) => r.requestId === requestId);

              if (request) {
                request.status = response.status;
              }
            }
          }

          // Network loading failed (lines 5000-5010)
          if (method === "Network.loadingFailed") {
            const requestId = params.requestId;
            const tabData = CDPHelper.networkRequestsByTab.get(tabId);
            if (tabData) {
              const request = tabData.requests.find((r) => r.requestId === requestId);

              if (request) {
                request.status = 503;
              }
            }
          }
        }
      };

      chrome.debugger.onEvent.addListener(globalThis.__cdpDebuggerEventHandler);
    }
  }

  initializeDebuggerEventListener() {
    if (!CDPHelper.debuggerListenerRegistered) {
      CDPHelper.debuggerListenerRegistered = true;
      this.registerDebuggerEventHandlers();
    }
  }

  // ============================================================================
  // DEBUGGER ATTACHMENT (lines 5032-5078)
  // ============================================================================

  async attachDebugger(tabId) {
    const target = { tabId };
    const networkWasEnabled = CDPHelper.networkTrackingEnabled.has(tabId);
    const consoleWasEnabled = CDPHelper.consoleTrackingEnabled.has(tabId);

    try {
      await this.detachDebugger(tabId);
    } catch {
      // Silently ignore - debugger may not be attached
    }

    await new Promise((resolve, reject) => {
      chrome.debugger.attach(target, "1.3", () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });

    this.registerDebuggerEventHandlers();

    if (consoleWasEnabled) {
      try {
        await this.sendCommand(tabId, "Runtime.enable");
      } catch {
        // Silently ignore - may fail if tab was closed
      }
    }

    if (networkWasEnabled) {
      try {
        await this.sendCommand(tabId, "Network.enable", { maxPostDataSize: 65536 });
      } catch {
        // Silently ignore - may fail if tab was closed
      }
    }
  }

  async detachDebugger(tabId) {
    return new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        resolve();
      });
    });
  }

  async isDebuggerAttached(tabId) {
    return new Promise((resolve) => {
      chrome.debugger.getTargets((targets) => {
        const target = targets.find((t) => t.tabId === tabId);
        resolve(target?.attached ?? false);
      });
    });
  }

  // ============================================================================
  // CDP COMMAND SENDING (lines 5079-5109)
  // ============================================================================

  async sendCommand(tabId, method, params) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result);
          }
        });
      });
    } catch (error) {
      // Auto-reattach if debugger was detached (lines 5091-5108)
      if (
        (error instanceof Error ? error.message : String(error))
          .toLowerCase()
          .includes("debugger is not attached")
      ) {
        await this.attachDebugger(tabId);

        return new Promise((resolve, reject) => {
          chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(result);
            }
          });
        });
      }
      throw error;
    }
  }

  // ============================================================================
  // MOUSE EVENTS (lines 5111-5142)
  // ============================================================================

  async dispatchMouseEvent(tabId, eventParams) {
    const params = {
      type: eventParams.type,
      x: Math.round(eventParams.x),
      y: Math.round(eventParams.y),
      modifiers: eventParams.modifiers || 0,
    };

    if (
      eventParams.type === "mousePressed" ||
      eventParams.type === "mouseReleased" ||
      eventParams.type === "mouseMoved"
    ) {
      params.button = eventParams.button || "none";

      // Add clickCount only for pressed/released (line 5126-5127)
      (eventParams.type !== "mousePressed" && eventParams.type !== "mouseReleased") ||
        (params.clickCount = eventParams.clickCount || 1);
    }

    // Add buttons for non-wheel events (lines 5130-5132)
    if (eventParams.type !== "mouseWheel") {
      params.buttons = eventParams.buttons !== undefined ? eventParams.buttons : 0;
    }

    // Add delta for wheel events (lines 5134-5138)
    if (
      eventParams.type === "mouseWheel" &&
      (eventParams.deltaX !== undefined || eventParams.deltaY !== undefined)
    ) {
      Object.assign(params, { deltaX: eventParams.deltaX || 0, deltaY: eventParams.deltaY || 0 });
    }

    await this.sendCommand(tabId, "Input.dispatchMouseEvent", params);
  }

  // ============================================================================
  // CLICK (lines 5150-5211)
  // ============================================================================

  async click(tabId, x, y, button = "left", clickCount = 1, modifiers = 0, antiBot = false, startX = null, startY = null) {
    await indicatorManager.hideIndicatorForToolUse(tabId);

    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      let buttons = 0;

      switch (button) {
        case "left":
          buttons = 1;
          break;
        case "right":
          buttons = 2;
          break;
        case "middle":
          buttons = 4;
          break;
      }

      if (antiBot) {
        // Pre-action delay
        await humanDelay(
          ANTI_BOT_CONFIG.general.preActionDelayMs,
          ANTI_BOT_CONFIG.general.preActionVariance
        );

        // Use provided start position or default to origin-ish
        const fromX = startX ?? Math.round(x * 0.3 + Math.random() * 100);
        const fromY = startY ?? Math.round(y * 0.3 + Math.random() * 100);

        let targetX = x;
        let targetY = y;

        // Maybe overshoot first
        const shouldOvershoot = Math.random() < ANTI_BOT_CONFIG.mouse.overshootChance;
        if (shouldOvershoot) {
          const overshoot = calculateOvershoot(x, y, ANTI_BOT_CONFIG.mouse.overshootRadius);
          targetX = overshoot.x;
          targetY = overshoot.y;
        }

        // Generate Bezier path to target (or overshoot point)
        const path = generateBezierPath(
          fromX, fromY, targetX, targetY,
          ANTI_BOT_CONFIG.mouse.movementSteps
        );

        // Move along the path with timing
        const stepDelay = ANTI_BOT_CONFIG.mouse.movementDurationMs / path.length;
        for (const point of path) {
          await this.dispatchMouseEvent(tabId, {
            type: "mouseMoved",
            x: point.x,
            y: point.y,
            button: "none",
            buttons: 0,
            modifiers,
          });
          await new Promise(resolve => setTimeout(resolve, stepDelay));
        }

        // If we overshot, now move to actual target with tighter curve
        if (shouldOvershoot) {
          const correctionPath = generateBezierPath(
            targetX, targetY, x, y,
            Math.round(ANTI_BOT_CONFIG.mouse.movementSteps / 3)
          );
          for (const point of correctionPath) {
            await this.dispatchMouseEvent(tabId, {
              type: "mouseMoved",
              x: point.x,
              y: point.y,
              button: "none",
              buttons: 0,
              modifiers,
            });
            await new Promise(resolve => setTimeout(resolve, stepDelay / 2));
          }
        }

        // Pre-click pause
        await humanDelay(ANTI_BOT_CONFIG.mouse.preClickDelayMs, 20);

      } else {
        // Original behavior: single move
        await this.dispatchMouseEvent(tabId, {
          type: "mouseMoved",
          x,
          y,
          button: "none",
          buttons: 0,
          modifiers,
        });

        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Click sequence
      for (let i = 1; i <= clickCount; i++) {
        await this.dispatchMouseEvent(tabId, {
          type: "mousePressed",
          x,
          y,
          button,
          buttons,
          clickCount: i,
          modifiers,
        });

        // Human-like click hold duration
        const holdTime = antiBot
          ? randomDelay(ANTI_BOT_CONFIG.mouse.clickHoldMs, ANTI_BOT_CONFIG.mouse.clickHoldVariance)
          : 12;
        await new Promise((resolve) => setTimeout(resolve, holdTime));

        await this.dispatchMouseEvent(tabId, {
          type: "mouseReleased",
          x,
          y,
          button,
          buttons: 0,
          modifiers,
          clickCount: i,
        });

        if (i < clickCount) {
          await new Promise((resolve) => setTimeout(resolve, antiBot ? randomDelay(150, 50) : 100));
        }
      }
    } finally {
      await indicatorManager.restoreIndicatorAfterToolUse(tabId);
    }
  }

  // ============================================================================
  // KEYBOARD EVENTS (lines 5143-5311)
  // ============================================================================

  async dispatchKeyEvent(tabId, eventParams) {
    const params = { modifiers: 0, ...eventParams };
    await this.sendCommand(tabId, "Input.dispatchKeyEvent", params);
  }

  async insertText(tabId, text) {
    await this.sendCommand(tabId, "Input.insertText", { text });
  }

  async type(tabId, text, antiBot = false) {
    // Pre-action delay for anti-bot
    if (antiBot) {
      await humanDelay(
        ANTI_BOT_CONFIG.general.preActionDelayMs,
        ANTI_BOT_CONFIG.general.preActionVariance
      );
    }

    for (const char of text) {
      let keyChar = char;

      if (char === "\n" || char === "\r") {
        keyChar = "Enter";
      }

      const keyDef = this.getKeyCode(keyChar);
      if (keyDef) {
        const shiftMod = this.requiresShift(char) ? 8 : 0;
        await this.pressKey(tabId, keyDef, shiftMod);
      } else {
        await this.insertText(tabId, char);
      }

      // Human-like delays between characters
      if (antiBot) {
        let delay = randomDelay(
          ANTI_BOT_CONFIG.typing.baseDelayMs,
          ANTI_BOT_CONFIG.typing.varianceMs
        );

        // Extra pause after punctuation
        if ('.!?;:'.includes(char)) {
          delay += ANTI_BOT_CONFIG.typing.punctuationPauseMs;
        }
        // Extra pause after space (between words)
        else if (char === ' ') {
          delay += randomDelay(
            ANTI_BOT_CONFIG.typing.wordPauseMs,
            ANTI_BOT_CONFIG.typing.varianceMs
          );
        }

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  async keyDown(tabId, keyDef, modifiers = 0, commands) {
    await this.dispatchKeyEvent(tabId, {
      type: keyDef.text ? "keyDown" : "rawKeyDown",
      key: keyDef.key,
      code: keyDef.code,
      windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode || keyDef.keyCode,
      modifiers,
      text: keyDef.text ?? "",
      unmodifiedText: keyDef.text ?? "",
      location: keyDef.location ?? 0,
      commands: commands ?? [],
      isKeypad: keyDef.isKeypad ?? false,
    });
  }

  async keyUp(tabId, keyDef, modifiers = 0) {
    await this.dispatchKeyEvent(tabId, {
      type: "keyUp",
      key: keyDef.key,
      modifiers,
      windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode || keyDef.keyCode,
      code: keyDef.code,
      location: keyDef.location ?? 0,
    });
  }

  async pressKey(tabId, keyDef, modifiers = 0, commands) {
    await this.keyDown(tabId, keyDef, modifiers, commands);
    await this.keyUp(tabId, keyDef, modifiers);
  }

  async pressKeyChord(tabId, chord) {
    const parts = chord.toLowerCase().split("+");
    const modifierParts = [];
    let mainKey = "";

    for (const part of parts) {
      if (
        [
          "ctrl",
          "control",
          "alt",
          "shift",
          "cmd",
          "meta",
          "command",
          "win",
          "windows",
        ].includes(part)
      ) {
        modifierParts.push(part);
      } else {
        mainKey = part;
      }
    }

    let modifiers = 0;
    const modifierMap = {
      alt: 1,
      ctrl: 2,
      control: 2,
      meta: 4,
      cmd: 4,
      command: 4,
      win: 4,
      windows: 4,
      shift: 8,
    };

    for (const mod of modifierParts) {
      modifiers |= modifierMap[mod] || 0;
    }

    const commands = [];
    if (this.isMac) {
      const macCommand = MAC_COMMANDS[chord.toLowerCase()];

      if (macCommand && Array.isArray(macCommand)) {
        commands.push(...macCommand);
      } else if (macCommand) {
        commands.push(macCommand);
      }
    }

    if (mainKey) {
      const keyDef = this.getKeyCode(mainKey);
      if (!keyDef) {
        throw new Error(`Unknown key: ${chord}`);
      }
      await this.pressKey(tabId, keyDef, modifiers, commands);
    }
  }

  // ============================================================================
  // SCROLL (line 5313-5321)
  // ============================================================================

  async scrollWheel(tabId, x, y, deltaX, deltaY, antiBot = false) {
    if (antiBot && (Math.abs(deltaX) > 50 || Math.abs(deltaY) > 50)) {
      // Pre-action delay
      await humanDelay(
        ANTI_BOT_CONFIG.general.preActionDelayMs,
        ANTI_BOT_CONFIG.general.preActionVariance
      );

      // Split scroll into multiple steps with easing (momentum-like)
      const steps = ANTI_BOT_CONFIG.scroll.stepCount;
      const stepDeltaX = deltaX / steps;
      const stepDeltaY = deltaY / steps;

      for (let i = 0; i < steps; i++) {
        // Ease-out: larger deltas at start, smaller at end (momentum)
        const easeFactor = 1 - (i / steps) * 0.5; // 1.0 -> 0.5

        await this.dispatchMouseEvent(tabId, {
          type: "mouseWheel",
          x,
          y,
          deltaX: Math.round(stepDeltaX * easeFactor * 2), // *2 to compensate for ease
          deltaY: Math.round(stepDeltaY * easeFactor * 2),
        });

        await humanDelay(
          ANTI_BOT_CONFIG.scroll.stepDelayMs,
          ANTI_BOT_CONFIG.scroll.stepVariance
        );
      }
    } else {
      // Original single scroll
      await this.dispatchMouseEvent(tabId, {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
      });
    }
  }

  // ============================================================================
  // KEY CODE HELPERS (lines 5322-5344)
  // ============================================================================

  getKeyCode(key) {
    const lowerKey = key.toLowerCase();
    const keyDef = KEY_DEFINITIONS[lowerKey];
    if (keyDef) {
      return keyDef;
    }
    if (key.length === 1) {
      const upper = key.toUpperCase();
      let code;
      if (upper >= "A" && upper <= "Z") {
        code = `Key${upper}`;
      } else {
        if (!(key >= "0" && key <= "9")) {
          return;
        }
        code = `Digit${key}`;
      }
      return { key, code, keyCode: upper.charCodeAt(0), text: key };
    }
  }

  requiresShift(char) {
    return '~!@#$%^&*()_+{}|:"<>?'.includes(char) || (char >= "A" && char <= "Z");
  }

  // ============================================================================
  // DOMAIN EXTRACTION (lines 5345-5354)
  // ============================================================================

  extractDomain(url) {
    if (!url) {
      return "unknown";
    }
    try {
      return new URL(url).hostname || "unknown";
    } catch {
      return "unknown";
    }
  }

  // ============================================================================
  // CONSOLE MESSAGE TRACKING (lines 5355-5413)
  // ============================================================================

  addConsoleMessage(tabId, domain, message) {
    let tabData = CDPHelper.consoleMessagesByTab.get(tabId);

    // Reset messages if domain changed, or create new entry if none exists
    if (!tabData || tabData.domain !== domain) {
      tabData = { domain, messages: [] };
      CDPHelper.consoleMessagesByTab.set(tabId, tabData);
    }

    // Ensure timestamps are non-decreasing (lines 5366-5372)
    if (tabData.messages.length > 0) {
      const lastTimestamp = tabData.messages[tabData.messages.length - 1].timestamp;

      if (message.timestamp < lastTimestamp) {
        message.timestamp = lastTimestamp;
      }
    }

    tabData.messages.push(message);

    // Trim to max size (lines 5376-5379)
    if (tabData.messages.length > CDPHelper.MAX_LOGS_PER_TAB) {
      const excess = tabData.messages.length - CDPHelper.MAX_LOGS_PER_TAB;
      tabData.messages.splice(0, excess);
    }
  }

  async enableConsoleTracking(tabId) {
    await this.sendCommand(tabId, "Runtime.enable");
    CDPHelper.consoleTrackingEnabled.add(tabId);
  }

  getConsoleMessages(tabId, errorsOnly = false, filter) {
    const tabData = CDPHelper.consoleMessagesByTab.get(tabId);
    if (!tabData) {
      return [];
    }
    let messages = tabData.messages;

    if (errorsOnly) {
      messages = messages.filter((m) => m.type === "error" || m.type === "exception");
    }

    if (filter) {
      try {
        const regex = new RegExp(filter, "i");
        messages = messages.filter((m) => regex.test(m.text));
      } catch {
        messages = messages.filter((m) => m.text.toLowerCase().includes(filter.toLowerCase()));
      }
    }

    return messages;
  }

  clearConsoleMessages(tabId) {
    CDPHelper.consoleMessagesByTab.delete(tabId);
  }

  // ============================================================================
  // NETWORK REQUEST TRACKING (lines 5414-5469)
  // ============================================================================

  addNetworkRequest(tabId, domain, request) {
    let tabData = CDPHelper.networkRequestsByTab.get(tabId);

    if (tabData) {
      if (tabData.domain !== domain) {
        tabData.domain = domain;
        tabData.requests = [];
      }
    } else {
      tabData = { domain, requests: [] };
      CDPHelper.networkRequestsByTab.set(tabId, tabData);
    }

    tabData.requests.push(request);

    // Trim to max size
    if (tabData.requests.length > CDPHelper.MAX_REQUESTS_PER_TAB) {
      const excess = tabData.requests.length - CDPHelper.MAX_REQUESTS_PER_TAB;
      tabData.requests.splice(0, excess);
    }
  }

  async enableNetworkTracking(tabId) {
    if (!CDPHelper.debuggerListenerRegistered) {
      this.initializeDebuggerEventListener();
    }

    try {
      await this.sendCommand(tabId, "Network.disable");
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      // Silently ignore - network may not have been enabled
    }

    await this.sendCommand(tabId, "Network.enable", { maxPostDataSize: 65536 });
    CDPHelper.networkTrackingEnabled.add(tabId);
  }

  getNetworkRequests(tabId, urlFilter) {
    const tabData = CDPHelper.networkRequestsByTab.get(tabId);
    if (!tabData) {
      return [];
    }
    let requests = tabData.requests;

    if (urlFilter) {
      requests = requests.filter((r) => r.url.includes(urlFilter));
    }

    return requests;
  }

  clearNetworkRequests(tabId) {
    CDPHelper.networkRequestsByTab.delete(tabId);
  }

  isNetworkTrackingEnabled(tabId) {
    return CDPHelper.networkTrackingEnabled.has(tabId);
  }

  // ============================================================================
  // SCREENSHOT (lines 5470-5692)
  // ============================================================================

  async screenshot(tabId, resizeParams) {
    const params = resizeParams || this.defaultResizeParams;
    await indicatorManager.hideIndicatorForToolUse(tabId);

    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      // Get viewport info (lines 5477-5488)
      const viewportResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        }),
      });
      if (!viewportResult || !viewportResult[0]?.result) {
        throw new Error("Failed to get viewport information");
      }
      const { width, height, devicePixelRatio } = viewportResult[0].result;

      // Capture screenshot via CDP as JPEG to minimize size from the start
      const captureResult = await this.sendCommand(tabId, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
        captureBeyondViewport: false,
        fromSurface: true,
      });

      if (!captureResult || !captureResult.data) {
        throw new Error("Failed to capture screenshot via CDP");
      }
      const base64Data = captureResult.data;

      // Check if Image is available (service worker vs content script)
      if (typeof Image == "undefined") {
        return await this.processScreenshotInContentScript(
          tabId,
          base64Data,
          width,
          height,
          devicePixelRatio,
          params
        );
      }

      // Process screenshot with Image
      const dataUrl = `data:image/jpeg;base64,${base64Data}`;

      const result = await new Promise((resolve, reject) => {
        const img = new Image();

        img.onload = () => {
          let processedWidth = img.width;
          let processedHeight = img.height;
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            return void reject(
              new Error("Failed to create 2D context for screenshot processing")
            );
          }

          // Handle DPR scaling (lines 5526-5536)
          if (devicePixelRatio > 1) {
            processedWidth = Math.round(img.width / devicePixelRatio);
            processedHeight = Math.round(img.height / devicePixelRatio);
            canvas.width = processedWidth;
            canvas.height = processedHeight;
            ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, processedWidth, processedHeight);
          } else {
            canvas.width = processedWidth;
            canvas.height = processedHeight;
            ctx.drawImage(img, 0, 0);
          }

          // Calculate target dimensions (line 5538)
          const [targetWidth, targetHeight] = calculateTargetDimensions(processedWidth, processedHeight, params);

          // No resize needed
          if (!(processedWidth !== targetWidth || processedHeight !== targetHeight)) {
            const outputBase64 = canvas.toDataURL("image/jpeg", 0.6).split(",")[1];
            return void resolve({
              base64: outputBase64,
              width: processedWidth,
              height: processedHeight,
              format: "jpeg",
              viewportWidth: width,
              viewportHeight: height,
            });
          }

          // Resize to target
          const targetCanvas = document.createElement("canvas");
          const targetCtx = targetCanvas.getContext("2d");
          if (!targetCtx) {
            return void reject(
              new Error("Failed to create 2D context for target resizing")
            );
          }
          targetCanvas.width = targetWidth;
          targetCanvas.height = targetHeight;
          targetCtx.drawImage(canvas, 0, 0, processedWidth, processedHeight, 0, 0, targetWidth, targetHeight);
          const outputBase64 = targetCanvas.toDataURL("image/jpeg", 0.6).split(",")[1];
          resolve({
            base64: outputBase64,
            width: targetWidth,
            height: targetHeight,
            format: "jpeg",
            viewportWidth: width,
            viewportHeight: height,
          });
        };

        img.onerror = () => {
          reject(new Error("Failed to load screenshot image"));
        };

        img.src = dataUrl;
      });

      // Store context for coordinate scaling (line 5578)
      screenshotContextManager.setContext(tabId, result);
      return result;
    } finally {
      await indicatorManager.restoreIndicatorAfterToolUse(tabId);
    }
  }

  async processScreenshotInContentScript(tabId, base64Data, viewportWidth, viewportHeight, devicePixelRatio, resizeParams) {
    const scriptResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: (base64, vWidth, vHeight, dpr, params, maxBase64Chars, initialQuality, qualityStep, minQuality) => {
        const dataUrl = `data:image/jpeg;base64,${base64}`;
        return new Promise((resolve, reject) => {
          const img = new Image();

          img.onload = () => {
            let processedWidth = img.width;
            let processedHeight = img.height;

            if (dpr > 1) {
              processedWidth = Math.round(img.width / dpr);
              processedHeight = Math.round(img.height / dpr);
            }

            const canvas = document.createElement("canvas");
            canvas.width = processedWidth;
            canvas.height = processedHeight;
            const ctx = canvas.getContext("2d");
            if (!ctx) {
              return void reject(new Error("Failed to get canvas context"));
            }

            if (dpr > 1) {
              ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, processedWidth, processedHeight);
            } else {
              ctx.drawImage(img, 0, 0);
            }

            // Calculate target dimensions
            const aspectRatio = processedWidth / processedHeight;
            const pxPerToken = params.pxPerToken || 28;
            const maxTargetTokens = params.maxTargetTokens || 768;
            const currentTokens = Math.ceil((processedWidth / pxPerToken) * (processedHeight / pxPerToken));
            let targetWidth = processedWidth;
            let targetHeight = processedHeight;
            if (currentTokens > maxTargetTokens) {
              const scale = Math.sqrt(maxTargetTokens / currentTokens);
              targetWidth = Math.round(processedWidth * scale);
              targetHeight = Math.round(targetWidth / aspectRatio);
            }

            // Compress to JPEG with quality reduction if needed
            const compressToJpeg = (sourceCanvas) => {
              let quality = initialQuality;
              let result = sourceCanvas.toDataURL("image/jpeg", quality).split(",")[1];

              while (result.length > maxBase64Chars && quality > minQuality) {
                quality -= qualityStep;
                result = sourceCanvas.toDataURL("image/jpeg", quality).split(",")[1];
              }

              return result;
            };

            if (targetWidth >= processedWidth && targetHeight >= processedHeight) {
              const outputBase64 = compressToJpeg(canvas);
              return void resolve({
                base64: outputBase64,
                width: processedWidth,
                height: processedHeight,
                format: "jpeg",
                viewportWidth: vWidth,
                viewportHeight: vHeight,
              });
            }

            const targetCanvas = document.createElement("canvas");
            targetCanvas.width = targetWidth;
            targetCanvas.height = targetHeight;
            const targetCtx = targetCanvas.getContext("2d");
            if (!targetCtx) {
              return void reject(new Error("Failed to get target canvas context"));
            }
            targetCtx.drawImage(canvas, 0, 0, processedWidth, processedHeight, 0, 0, targetWidth, targetHeight);
            const outputBase64 = compressToJpeg(targetCanvas);
            resolve({
              base64: outputBase64,
              width: targetWidth,
              height: targetHeight,
              format: "jpeg",
              viewportWidth: vWidth,
              viewportHeight: vHeight,
            });
          };

          img.onerror = () => {
            reject(new Error("Failed to load screenshot image"));
          };

          img.src = dataUrl;
        });
      },
      args: [
        base64Data,
        viewportWidth,
        viewportHeight,
        devicePixelRatio,
        resizeParams,
        CDPHelper.MAX_BASE64_CHARS,
        CDPHelper.INITIAL_JPEG_QUALITY,
        CDPHelper.JPEG_QUALITY_STEP,
        CDPHelper.MIN_JPEG_QUALITY,
      ],
    });

    if (!scriptResult || !scriptResult[0]?.result) {
      throw new Error("Failed to process screenshot in content script");
    }
    const result = scriptResult[0].result;
    screenshotContextManager.setContext(tabId, result);
    return result;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculate target dimensions for screenshot resizing
 * Maintains aspect ratio while fitting within max dimensions
 */
function calculateTargetDimensions(width, height, params) {
  const { pxPerToken, maxTargetPx, maxTargetTokens } = params;

  // Helper to calculate token count
  const calculateTokens = (w, h, ppt) => Math.ceil((w / ppt) * (h / ppt));

  if (
    width <= maxTargetPx &&
    height <= maxTargetPx &&
    calculateTokens(width, height, pxPerToken) <= maxTargetTokens
  ) {
    return [width, height];
  }

  // Handle portrait orientation by swapping
  if (height > width) {
    const [h, w] = calculateTargetDimensions(height, width, params);
    return [w, h];
  }

  const aspectRatio = width / height;
  let high = width;
  let low = 1;

  // Binary search to find optimal dimensions
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    const midHeight = Math.max(Math.round(mid / aspectRatio), 1);

    if (mid <= maxTargetPx && calculateTokens(mid, midHeight, pxPerToken) <= maxTargetTokens) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return [low, Math.max(Math.round(low / aspectRatio), 1)];
}

// ============================================================================
// EXPORTS
// ============================================================================

// Create singleton instance (mirrors line 5694: const re = new te())
export const cdpHelper = new CDPHelper();

// Also export the class for testing
export { CDPHelper, calculateTargetDimensions };
