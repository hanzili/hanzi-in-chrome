/**
 * Computer tool handler
 * Handles screenshot, click, type, scroll, mouse movement, and keyboard actions
 *
 * Anti-Bot Support:
 * When the current tab's URL matches a domain with antiBot: true,
 * actions will simulate human-like behavior (delays, Bezier curves, etc.)
 */

import { cdpHelper } from '../modules/cdp-helper.js';
import { screenshotContextManager, scaleCoordinates } from '../modules/screenshot-context.js';
import { ensureDebugger, sendDebuggerCommand } from '../managers/debugger-manager.js';
import { isAntiBotEnabled } from '../modules/domain-skills.js';
import { createElementResolver } from '../dom-service/element-resolver.js';

// CDP-based element resolver (stable backendNodeId refs, no WeakRef GC issues)
const elementResolver = createElementResolver(sendDebuggerCommand);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Generate unique screenshot ID
 */
let screenshotCounter = 0;
function generateScreenshotId() {
  return `screenshot_${++screenshotCounter}`;
}

/**
 * Security check - verify domain hasn't changed during action
 * @param {number} tabId - Tab ID to check
 * @param {string} originalUrl - Original URL before action
 * @param {string} actionName - Name of action for error message
 * @returns {Promise<{error: string}|null>} Error object or null if OK
 */
async function securityCheck(tabId, originalUrl, actionName) {
  if (!originalUrl) {
    return null;
  }
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url) {
    return { error: "Unable to verify current URL for security check" };
  }
  const extractDomain = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };
  const originalDomain = extractDomain(originalUrl);
  const currentDomain = extractDomain(tab.url);
  return originalDomain !== currentDomain
    ? {
        error: `Security check failed: Domain changed from ${originalDomain} to ${currentDomain} during ${actionName}`,
      }
    : null;
}

/**
 * Resolves element reference to screen coordinates for clicking.
 *
 * Supports two ref formats:
 * - Numeric backendNodeId (from CDP read_page): "857" or 857 → resolved via CDP
 * - Legacy ref_N (from content script find): "ref_42" → resolved via WeakRef
 *
 * @param {number} tabId - Tab ID
 * @param {string|number} ref - Element reference
 * @returns {Promise<{success: boolean, coordinates?: [number, number], directClicked?: boolean, error?: string}>}
 */
async function getElementFromRef(tabId, ref) {
  // Try CDP path first (numeric backendNodeId)
  const backendNodeId = elementResolver.parseRef(ref);
  if (backendNodeId) {
    try {
      await ensureDebugger(tabId);
      const coords = await elementResolver.getCoordinates(tabId, backendNodeId);
      if (coords.directClicked) {
        return { success: true, coordinates: [coords.x, coords.y], directClicked: true };
      }
      return { success: true, coordinates: [coords.x, coords.y] };
    } catch (err) {
      return {
        success: false,
        error: `Element ${backendNodeId}: ${err instanceof Error ? err.message : 'Unknown error'}`,
      };
    }
  }

  // Legacy path: ref_N format via content script WeakRef
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (refId) => {
        try {
          let element = null;
          if (window.__elementRefMap && window.__elementRefMap[refId]) {
            element = window.__elementRefMap[refId].deref() || null;
            if (!element || !document.contains(element)) {
              delete window.__elementRefMap[refId];
              element = null;
            }
          }
          if (!element) {
            return { success: false, error: `No element found with reference: "${refId}". The element may have been removed from the page.` };
          }
          element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
          if (element instanceof HTMLElement) element.offsetHeight;
          const rect = element.getBoundingClientRect();
          return { success: true, coordinates: [rect.left + rect.width / 2, rect.top + rect.height / 2] };
        } catch (err) {
          return { success: false, error: `Error getting element coordinates: ${err instanceof Error ? err.message : "Unknown error"}` };
        }
      },
      args: [ref],
    });
    return result?.[0]?.result || { success: false, error: "Failed to execute script to get element coordinates" };
  } catch (err) {
    return { success: false, error: `Failed to get element coordinates from ref: ${err instanceof Error ? err.message : "Unknown error"}` };
  }
}

/**
 * Get current scroll position
 *
 * @param {number} tabId - Tab ID
 * @returns {Promise<{x: number, y: number}>}
 */
async function getScrollPosition(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      x: window.pageXOffset || document.documentElement.scrollLeft,
      y: window.pageYOffset || document.documentElement.scrollTop,
    }),
  });
  if (!result || !result[0]?.result) {
    throw new Error("Failed to get scroll position");
  }
  return result[0].result;
}

/**
 * Scroll via JavaScript (fallback when CDP scroll doesn't work)
 *
 * @param {number} tabId - Tab ID
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {number} deltaX - Horizontal scroll amount
 * @param {number} deltaY - Vertical scroll amount
 */
async function scrollViaJavaScript(tabId, x, y, deltaX, deltaY) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (dx, dy, posX, posY) => {
      const elementAtPoint = document.elementFromPoint(posX, posY);
      if (elementAtPoint && elementAtPoint !== document.body && elementAtPoint !== document.documentElement) {
        const isScrollable = (el) => {
          const style = window.getComputedStyle(el);
          const overflowY = style.overflowY;
          const overflowX = style.overflowX;
          return (
            (overflowY === "auto" ||
              overflowY === "scroll" ||
              overflowX === "auto" ||
              overflowX === "scroll") &&
            (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
          );
        };
        let scrollableParent = elementAtPoint;

        while (scrollableParent && !isScrollable(scrollableParent)) {
          scrollableParent = scrollableParent.parentElement;
        }

        if (scrollableParent && isScrollable(scrollableParent)) {
          return void scrollableParent.scrollBy({ left: dx, top: dy, behavior: "instant" });
        }
      }
      window.scrollBy({ left: dx, top: dy, behavior: "instant" });
    },
    args: [deltaX, deltaY, x, y],
  });
}

/**
 * Handle click action
 * Performs mouse click at specified coordinates with human-like movement
 *
 * @param {number} tabId - Tab ID
 * @param {Object} input - Tool input with coordinate/ref, action, modifiers
 * @param {number} clickCount - 1 for single, 2 for double, 3 for triple
 * @param {string} originalUrl - URL for security check
 * @param {boolean} antiBot - If true, use human-like mouse movement
 * @returns {Promise<{output?: string, error?: string}>}
 */
async function handleClick(tabId, input, clickCount = 1, originalUrl, antiBot = false) {
  // Ensure tab is active before clicking - required for proper focus
  await chrome.tabs.update(tabId, { active: true });

  let x, y;

  if (input.ref) {
    const refResult = await getElementFromRef(tabId, input.ref);
    if (!refResult.success) {
      return { error: refResult.error };
    }
    if (refResult.directClicked) {
      // Element had no box model — was clicked directly via JS by the resolver
      return { output: `Clicked element ${input.ref} (direct JS click — element has no visual bounds)` };
    }
    [x, y] = refResult.coordinates;
  } else {
    if (!input.coordinate) {
      throw new Error(
        "Either ref or coordinate parameter is required for click action"
      );
    }
    [x, y] = input.coordinate;
    const context = screenshotContextManager.getContext(tabId);
    if (context) {
      [x, y] = scaleCoordinates(x, y, context);
    }
  }

  const button = input.action === "right_click" ? "right" : "left";
  let modifiers = 0;

  if (input.modifiers) {
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
    const modifierNames = input.modifiers
      .toLowerCase()
      .split("+")
      .filter((m) =>
        ["ctrl", "control", "alt", "shift", "cmd", "meta", "command", "win", "windows"].includes(m.trim())
      );
    for (const mod of modifierNames) {
      modifiers |= modifierMap[mod] || 0;
    }
  }

  try {
    const secCheck = await securityCheck(tabId, originalUrl, "click action");
    if (secCheck) {
      return secCheck;
    }
    await cdpHelper.click(tabId, x, y, button, clickCount, modifiers, antiBot);
    const actionName =
      clickCount === 1 ? "Clicked" : clickCount === 2 ? "Double-clicked" : "Triple-clicked";
    const mode = antiBot ? " (human-like)" : "";
    return input.ref
      ? { output: `${actionName} on element ${input.ref}${mode}` }
      : {
          output: `${actionName} at (${Math.round(input.coordinate[0])}, ${Math.round(
            input.coordinate[1]
          )})${mode}`,
        };
  } catch (err) {
    return {
      error: `Error clicking: ${
        err instanceof Error ? err.message : "Unknown error"
      }`,
    };
  }
}

/**
 * Handle screenshot action
 * Captures viewport screenshot with proper DPR handling
 *
 * @param {number} tabId - Tab ID
 * @returns {Promise<{output?: string, base64Image?: string, imageFormat?: string, imageId?: string, error?: string}>}
 */
async function handleScreenshot(tabId) {
  try {
    const result = await cdpHelper.screenshot(tabId);
    const imageId = generateScreenshotId();
    console.info(`[Computer Tool] Generated screenshot ID: ${imageId}`);
    console.info(`[Computer Tool] Screenshot dimensions: ${result.width}x${result.height}`);

    return {
      output: `Successfully captured screenshot (${result.width}x${result.height}, ${result.format}) - ID: ${imageId}`,
      base64Image: result.base64,
      imageFormat: result.format,
      imageId,
    };
  } catch (err) {
    return {
      error: `Error capturing screenshot: ${
        err instanceof Error ? err.message : "Unknown error"
      }`,
    };
  }
}

// ============================================================================
// MAIN COMPUTER TOOL HANDLER
// ============================================================================

/**
 * Handle computer tool - main dispatcher
 *
 * @param {Object} input - Tool input
 * @param {string} input.action - Action to perform
 * @param {number} input.tabId - Tab ID
 * @param {Array<number>} [input.coordinate] - [x, y] coordinates
 * @param {string} [input.ref] - Element reference
 * @param {string} [input.text] - Text for type/key actions
 * @param {number} [input.duration] - Wait duration
 * @param {string} [input.scroll_direction] - Scroll direction
 * @param {number} [input.scroll_amount] - Scroll amount
 * @param {Array<number>} [input.start_coordinate] - Start coords for drag
 * @param {Array<number>} [input.region] - Region for zoom [x0, y0, x1, y1]
 * @param {number} [input.repeat] - Key repeat count
 * @param {string} [input.modifiers] - Modifier keys for clicks
 * @returns {Promise<Object>} Tool result
 */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity, max-lines-per-function
export async function handleComputer(input) {
  try {
    const toolInput = input || {};
    if (!toolInput.action) {
      throw new Error("Action parameter is required");
    }

    // Normalize common LLM mistakes in action names
    if (toolInput.action === "scroll_direction" || toolInput.action === "scroll_down" || toolInput.action === "scroll_up") {
      if (!toolInput.scroll_direction && (toolInput.action === "scroll_down" || toolInput.action === "scroll_up")) {
        toolInput.scroll_direction = toolInput.action === "scroll_down" ? "down" : "up";
      }
      toolInput.action = "scroll";
      if (!toolInput.coordinate) toolInput.coordinate = [500, 400];
    }

    if (!toolInput.tabId) {
      throw new Error("No active tab found in context");
    }

    const tabId = toolInput.tabId;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.id) {
      throw new Error("Active tab has no ID");
    }

    // Ensure debugger is attached BEFORE any action (prevents "not attached" errors)
    await ensureDebugger(tabId);

    const originalUrl = tab.url;
    // Check if anti-bot simulation is needed for this domain
    const antiBot = isAntiBotEnabled(originalUrl);
    let result;

    switch (toolInput.action) {
      case "left_click":
      case "right_click": {
        result = await handleClick(tabId, toolInput, 1, originalUrl, antiBot);
        break;
      }

      case "double_click": {
        result = await handleClick(tabId, toolInput, 2, originalUrl, antiBot);
        break;
      }

      case "triple_click": {
        result = await handleClick(tabId, toolInput, 3, originalUrl, antiBot);
        break;
      }

      case "type": {
        if (!toolInput.text) {
          throw new Error("Text parameter is required for type action");
        }
        try {
          const secCheck = await securityCheck(tabId, originalUrl, "type action");
          if (secCheck) {
            result = secCheck;
          } else {
            // Ensure tab is active before typing - required for apps like Google Docs
            await chrome.tabs.update(tabId, { active: true });
            await new Promise(resolve => setTimeout(resolve, 100)); // Brief delay for focus
            await cdpHelper.type(tabId, toolInput.text, antiBot);
            const mode = antiBot ? " (human-like)" : "";
            result = { output: `Typed "${toolInput.text}"${mode}` };
          }
        } catch (err) {
          result = {
            error: `Failed to type: ${
              err instanceof Error ? err.message : "Unknown error"
            }`,
          };
        }
        break;
      }

      case "screenshot": {
        result = await handleScreenshot(tabId);
        break;
      }

      case "wait": {
        if (!toolInput.duration || toolInput.duration <= 0) {
          throw new Error("Duration parameter is required and must be positive");
        }
        if (toolInput.duration > 30) {
          throw new Error("Duration cannot exceed 30 seconds");
        }
        const waitMs = Math.round(1000 * toolInput.duration);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        result = {
          output: `Waited for ${toolInput.duration} second${
            toolInput.duration === 1 ? "" : "s"
          }`,
        };
        break;
      }

      case "scroll": {
        if (!toolInput.coordinate || toolInput.coordinate.length !== 2) {
          throw new Error("Coordinate parameter is required for scroll action");
        }
        let [x, y] = toolInput.coordinate;
        const context = screenshotContextManager.getContext(tabId);
        if (context) {
          [x, y] = scaleCoordinates(x, y, context);
        }
        const direction = toolInput.scroll_direction || "down";
        const amount = toolInput.scroll_amount || 3;

        try {
          let deltaX = 0;
          let deltaY = 0;
          const scrollUnit = 100;

          // Calculate scroll deltas based on direction
          const scrollDeltas = {
            up: { deltaX: 0, deltaY: -amount * scrollUnit },
            down: { deltaX: 0, deltaY: amount * scrollUnit },
            left: { deltaX: -amount * scrollUnit, deltaY: 0 },
            right: { deltaX: amount * scrollUnit, deltaY: 0 },
          };

          if (!scrollDeltas[direction]) {
            throw new Error(`Invalid scroll direction: ${direction}`);
          }
          deltaX = scrollDeltas[direction].deltaX;
          deltaY = scrollDeltas[direction].deltaY;

          const beforeScroll = await getScrollPosition(tabId);
          const currentTab = await chrome.tabs.get(tabId);

          if (currentTab.active ?? false) {
            try {
              const scrollPromise = cdpHelper.scrollWheel(tabId, x, y, deltaX, deltaY, antiBot);
              const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error("Scroll timeout")), 5000);
              });
              await Promise.race([scrollPromise, timeoutPromise]);
              await new Promise((resolve) => setTimeout(resolve, 200));

              const afterScroll = await getScrollPosition(tabId);
              if (!(Math.abs(afterScroll.x - beforeScroll.x) > 5 || Math.abs(afterScroll.y - beforeScroll.y) > 5)) {
                throw new Error("CDP scroll ineffective");
              }
            } catch {
              await scrollViaJavaScript(tabId, x, y, deltaX, deltaY);
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          } else {
            await scrollViaJavaScript(tabId, x, y, deltaX, deltaY);
            await new Promise((resolve) => setTimeout(resolve, 200));
          }

          // Automatically capture a screenshot after scrolling
          // Source: tools-and-permissions.js lines 6055-6074
          const screenshotResult = await (async () => {
            try {
              const screenshot = await handleScreenshot(tabId);
              return screenshot.base64Image
                ? { base64Image: screenshot.base64Image, imageFormat: screenshot.imageFormat || "png" }
                : undefined;
            } catch {
              return undefined;
            }
          })();

          const scrollMode = antiBot ? " (human-like)" : "";
          result = {
            output: `Scrolled ${direction} by ${amount} ticks at (${x}, ${y})${scrollMode}`,
            ...(screenshotResult && {
              base64Image: screenshotResult.base64Image,
              imageFormat: screenshotResult.imageFormat,
            }),
          };
        } catch (err) {
          result = {
            error: `Error scrolling: ${
              err instanceof Error ? err.message : "Unknown error"
            }`,
          };
        }
        break;
      }

      case "key": {
        if (!toolInput.text) {
          throw new Error("Text parameter is required for key action");
        }
        const repeatCount = toolInput.repeat ?? 1;
        if (!Number.isInteger(repeatCount) || repeatCount < 1) {
          throw new Error("Repeat parameter must be a positive integer");
        }
        if (repeatCount > 100) {
          throw new Error("Repeat parameter cannot exceed 100");
        }

        try {
          const secCheck = await securityCheck(tabId, originalUrl, "key action");
          if (secCheck) {
            result = secCheck;
            break;
          }

          const keyInputs = toolInput.text
            .trim()
            .split(/\s+/)
            .filter((k) => k.length > 0);
          console.info({ keyInputs });

          // Handle reload shortcuts specially
          if (keyInputs.length === 1) {
            const key = keyInputs[0].toLowerCase();
            if (
              key === "cmd+r" ||
              key === "cmd+shift+r" ||
              key === "ctrl+r" ||
              key === "ctrl+shift+r" ||
              key === "f5" ||
              key === "ctrl+f5" ||
              key === "shift+f5"
            ) {
              const hardReload =
                key === "cmd+shift+r" ||
                key === "ctrl+shift+r" ||
                key === "ctrl+f5" ||
                key === "shift+f5";
              await chrome.tabs.reload(tabId, { bypassCache: hardReload });
              const reloadType = hardReload ? "hard reload" : "reload";
              result = { output: `Executed ${keyInputs[0]} (${reloadType} page)` };
              break;
            }
          }

          for (let i = 0; i < repeatCount; i++) {
            for (const key of keyInputs) {
              if (key.includes("+")) {
                await cdpHelper.pressKeyChord(tabId, key);
              } else {
                const keyDef = cdpHelper.getKeyCode(key);
                // eslint-disable-next-line max-depth
                if (keyDef) {
                  await cdpHelper.pressKey(tabId, keyDef);
                } else {
                  await cdpHelper.insertText(tabId, key);
                }
              }
            }
          }

          const repeatSuffix = repeatCount > 1 ? ` (repeated ${repeatCount} times)` : "";
          result = {
            output: `Pressed ${keyInputs.length} key${
              keyInputs.length === 1 ? "" : "s"
            }: ${keyInputs.join(" ")}${repeatSuffix}`,
          };
        } catch (err) {
          result = {
            error: `Error pressing key: ${
              err instanceof Error ? err.message : "Unknown error"
            }`,
          };
        }
        break;
      }

      case "left_click_drag": {
        if (!toolInput.start_coordinate || toolInput.start_coordinate.length !== 2) {
          throw new Error("start_coordinate parameter is required for left_click_drag action");
        }
        if (!toolInput.coordinate || toolInput.coordinate.length !== 2) {
          throw new Error("coordinate parameter (end position) is required for left_click_drag action");
        }

        let [startX, startY] = toolInput.start_coordinate;
        let [endX, endY] = toolInput.coordinate;
        const context = screenshotContextManager.getContext(tabId);
        if (context) {
          [startX, startY] = scaleCoordinates(startX, startY, context);
          [endX, endY] = scaleCoordinates(endX, endY, context);
        }

        try {
          const secCheck = await securityCheck(tabId, originalUrl, "drag action");
          if (secCheck) {
            result = secCheck;
            break;
          }

          await cdpHelper.dispatchMouseEvent(tabId, {
            type: "mouseMoved",
            x: startX,
            y: startY,
            button: "none",
            buttons: 0,
            modifiers: 0,
          });
          await cdpHelper.dispatchMouseEvent(tabId, {
            type: "mousePressed",
            x: startX,
            y: startY,
            button: "left",
            buttons: 1,
            clickCount: 1,
            modifiers: 0,
          });
          await cdpHelper.dispatchMouseEvent(tabId, {
            type: "mouseMoved",
            x: endX,
            y: endY,
            button: "left",
            buttons: 1,
            modifiers: 0,
          });
          await cdpHelper.dispatchMouseEvent(tabId, {
            type: "mouseReleased",
            x: endX,
            y: endY,
            button: "left",
            buttons: 0,
            clickCount: 1,
            modifiers: 0,
          });
          result = { output: `Dragged from (${startX}, ${startY}) to (${endX}, ${endY})` };
        } catch (err) {
          result = {
            error: `Error performing drag: ${
              err instanceof Error ? err.message : "Unknown error"
            }`,
          };
        }
        break;
      }

      case "zoom": {
        if (!toolInput.region || toolInput.region.length !== 4) {
          throw new Error("Region parameter is required for zoom action and must be [x0, y0, x1, y1]");
        }
        let [x0, y0, x1, y1] = toolInput.region;
        if (x0 < 0 || y0 < 0 || x1 <= x0 || y1 <= y0) {
          throw new Error("Invalid region coordinates: x0 and y0 must be non-negative, and x1 > x0, y1 > y0");
        }

        try {
          const context = screenshotContextManager.getContext(tabId);
          if (context) {
            [x0, y0] = scaleCoordinates(x0, y0, context);
            [x1, y1] = scaleCoordinates(x1, y1, context);
          }

          const viewportResult = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => ({
              width: window.innerWidth,
              height: window.innerHeight,
            }),
          });
          if (!viewportResult || !viewportResult[0]?.result) {
            throw new Error("Failed to get viewport dimensions");
          }
          const { width, height } = viewportResult[0].result;
          if (x1 > width || y1 > height) {
            throw new Error(
              `Region exceeds viewport boundaries (${width}x${height}). Please choose a region within the visible viewport.`
            );
          }

          const regionWidth = x1 - x0;
          const regionHeight = y1 - y0;

          const captureResult = await cdpHelper.sendCommand(tabId, "Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
            fromSurface: true,
            clip: { x: x0, y: y0, width: regionWidth, height: regionHeight, scale: 1 },
          });

          if (!captureResult || !captureResult.data) {
            throw new Error("Failed to capture zoomed screenshot via CDP");
          }
          result = {
            output: `Successfully captured zoomed screenshot of region (${x0},${y0}) to (${x1},${y1}) - ${regionWidth}x${regionHeight} pixels`,
            base64Image: captureResult.data,
            imageFormat: "png",
          };
        } catch (err) {
          result = {
            error: `Error capturing zoomed screenshot: ${
              err instanceof Error ? err.message : "Unknown error"
            }`,
          };
        }
        break;
      }

      case "scroll_to": {
        // Source: lines 6310-6331 - does NOT auto-screenshot (unlike scroll action)
        if (!toolInput.ref) {
          throw new Error("ref parameter is required for scroll_to action");
        }
        try {
          const secCheck = await securityCheck(tabId, originalUrl, "scroll_to action");
          if (secCheck) {
            result = secCheck;
            break;
          }
          const refResult = await getElementFromRef(tabId, toolInput.ref);
          result = refResult.success
            ? { output: `Scrolled to element with reference: ${toolInput.ref}` }
            : { error: refResult.error };
        } catch (err) {
          result = {
            error: `Failed to scroll to element: ${
              err instanceof Error ? err.message : "Unknown error"
            }`,
          };
        }
        break;
      }

      case "hover": {
        let x, y;
        if (toolInput.ref) {
          const refResult = await getElementFromRef(tabId, toolInput.ref);
          if (!refResult.success) {
            result = { error: refResult.error };
            break;
          }
          [x, y] = refResult.coordinates;
        } else {
          if (!toolInput.coordinate) {
            throw new Error("Either ref or coordinate parameter is required for hover action");
          }
          [x, y] = toolInput.coordinate;
          const context = screenshotContextManager.getContext(tabId);
          if (context) {
            [x, y] = scaleCoordinates(x, y, context);
          }
        }

        try {
          const secCheck = await securityCheck(tabId, originalUrl, "hover action");
          if (secCheck) {
            result = secCheck;
            break;
          }
          await cdpHelper.dispatchMouseEvent(tabId, {
            type: "mouseMoved",
            x,
            y,
            button: "none",
            buttons: 0,
            modifiers: 0,
          });
          result = toolInput.ref
            ? { output: `Hovered over element ${toolInput.ref}` }
            : {
                output: `Hovered at (${Math.round(toolInput.coordinate[0])}, ${Math.round(toolInput.coordinate[1])})`,
              };
        } catch (err) {
          result = {
            error: `Error hovering: ${
              err instanceof Error ? err.message : "Unknown error"
            }`,
          };
        }
        break;
      }

      default: {
        throw new Error(`Unsupported action: ${toolInput.action}`);
      }
    }

    return result;
  } catch (err) {
    return {
      error: `Failed to execute action: ${
        err instanceof Error ? err.message : "Unknown error"
      }`,
    };
  }
}
