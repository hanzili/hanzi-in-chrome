/**
 * CDP Element Resolver
 *
 * Resolves backendNodeId references to live DOM elements via Chrome DevTools Protocol.
 * Replaces the WeakRef-based ref_N system with Chrome's stable internal identifiers.
 *
 * Usage:
 *   import { createElementResolver } from './element-resolver.js';
 *   const resolver = createElementResolver(sendDebuggerCommand);
 *   const coords = await resolver.getCoordinates(tabId, backendNodeId);
 *   const result = await resolver.callFunction(tabId, backendNodeId, fn, args);
 */

/**
 * Create an element resolver bound to a CDP send function.
 *
 * @param {(tabId: number, method: string, params?: Object) => Promise<*>} sendCommand
 * @returns {ElementResolver}
 */
export function createElementResolver(sendCommand) {
  /**
   * Resolve a backendNodeId to a Runtime.RemoteObject.
   * @param {number} tabId
   * @param {number} backendNodeId
   * @returns {Promise<string>} objectId for use with Runtime.callFunctionOn
   */
  async function resolveNode(tabId, backendNodeId) {
    const result = await sendCommand(tabId, 'DOM.resolveNode', {
      backendNodeId,
    });
    if (!result?.object?.objectId) {
      throw new Error(`Could not resolve element ${backendNodeId} — it may have been removed from the page`);
    }
    return result.object.objectId;
  }

  /**
   * Execute a function on an element identified by backendNodeId.
   *
   * @param {number} tabId
   * @param {number} backendNodeId
   * @param {string} functionDeclaration - JS function source, first param is the element
   * @param {Array<{value: *}>} [callArgs] - Additional arguments after the element
   * @returns {Promise<*>} Return value from the function (must be JSON-serializable)
   */
  async function callFunction(tabId, backendNodeId, functionDeclaration, callArgs = []) {
    const objectId = await resolveNode(tabId, backendNodeId);
    const result = await sendCommand(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: [{ objectId }, ...callArgs],
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Unknown error';
      throw new Error(`Error on element ${backendNodeId}: ${msg}`);
    }
    return result?.result?.value;
  }

  /**
   * Get the center coordinates of an element, scrolling it into view first.
   *
   * @param {number} tabId
   * @param {number} backendNodeId
   * @returns {Promise<{x: number, y: number}>}
   */
  async function getCoordinates(tabId, backendNodeId) {
    // Scroll into view first
    try {
      await sendCommand(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
    } catch {
      // Fallback: use JS scrollIntoView
      const objectId = await resolveNode(tabId, backendNodeId);
      await sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: '(el) => el.scrollIntoView({behavior:"instant",block:"center",inline:"center"})',
        arguments: [{ objectId }],
      });
    }

    // Get the box model for accurate coordinates
    try {
      const box = await sendCommand(tabId, 'DOM.getBoxModel', { backendNodeId });
      if (box?.model?.content) {
        // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
        const quad = box.model.content;
        const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
        const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
        return { x, y };
      }
    } catch {
      // Fallback: use getBoundingClientRect via JS
    }

    // Fallback: getBoundingClientRect
    try {
      const rect = await callFunction(
        tabId,
        backendNodeId,
        `(el) => {
          if (typeof el.getBoundingClientRect !== 'function') return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }`,
      );
      if (rect && typeof rect.x === 'number') {
        return rect;
      }
    } catch {
      // Fall through to direct click fallback
    }

    // Last resort: click the element directly and return sentinel coordinates
    // Some ATS (SuccessFactors) render elements that have no box model or bounding rect
    await callFunction(
      tabId,
      backendNodeId,
      `(el) => {
        if (typeof el.click === 'function') el.click();
        else if (el.parentElement) el.parentElement.click();
      }`,
    );
    return { x: -1, y: -1, directClicked: true };
  }

  /**
   * Scroll element into view.
   *
   * @param {number} tabId
   * @param {number} backendNodeId
   */
  async function scrollIntoView(tabId, backendNodeId) {
    try {
      await sendCommand(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
    } catch {
      const objectId = await resolveNode(tabId, backendNodeId);
      await sendCommand(tabId, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: '(el) => el.scrollIntoView({behavior:"smooth",block:"center"})',
        arguments: [{ objectId }],
      });
    }
  }

  /**
   * Set files on a file input element.
   *
   * @param {number} tabId
   * @param {number} backendNodeId
   * @param {string[]} files - Array of file paths
   */
  async function setFileInputFiles(tabId, backendNodeId, files) {
    await sendCommand(tabId, 'DOM.setFileInputFiles', {
      files,
      backendNodeId,
    });
  }

  /**
   * Parse a ref string into a backendNodeId.
   * Accepts: "42", 42, "ref_42" (legacy)
   * Returns null if not parseable as backendNodeId (must use legacy WeakRef path).
   *
   * @param {string|number} ref
   * @returns {number|null}
   */
  function parseRef(ref) {
    if (typeof ref === 'number') return ref;
    if (typeof ref === 'string') {
      // Legacy ref_N format — not a backendNodeId
      if (ref.startsWith('ref_')) return null;
      const n = parseInt(ref, 10);
      if (!isNaN(n) && n > 0) return n;
    }
    return null;
  }

  return {
    resolveNode,
    callFunction,
    getCoordinates,
    scrollIntoView,
    setFileInputFiles,
    parseRef,
  };
}
