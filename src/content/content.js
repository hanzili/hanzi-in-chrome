/**
 * Content Script
 *
 * Bridges the accessibility tree and tool execution with the background service worker.
 */

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'PING':
      sendResponse({ success: true });
      return false;

    case 'READ_PAGE':
      handleReadPage(payload, sendResponse);
      return true; // async response

    case 'FORM_INPUT':
      handleFormInput(payload, sendResponse);
      return true;

    case 'GET_ELEMENT_RECT':
      handleGetElementRect(payload, sendResponse);
      return true;

    case 'SCROLL_TO_REF':
      handleScrollToRef(payload, sendResponse);
      return true;

    case 'CLICK_REF':
      handleClickRef(payload, sendResponse);
      return true;

    case 'GET_PAGE_TEXT':
      handleGetPageText(sendResponse);
      return true;

    case 'SCROLL_TO_ELEMENT':
      handleScrollToElement(payload, sendResponse);
      return true;

    case 'UPLOAD_IMAGE':
      handleUploadImage(payload, sendResponse);
      return true;

    case 'FIND_AND_SCROLL':
      handleFindAndScroll(payload, sendResponse);
      return true;

    case 'GET_ELEMENT_SELECTOR':
      handleGetElementSelector(payload, sendResponse);
      return true;

    default:
      sendResponse({ error: `Unknown message type: ${type}` });
      return false;
  }
});

/**
 * Handle read_page tool
 */
function handleReadPage(payload, sendResponse) {
  try {
    const { filter = 'all', depth = 15, maxChars = 50000, ref_id = null } = payload || {};

    // Call with positional args: (filter, maxDepth, maxChars, refId)
    const result = window.__generateAccessibilityTree(filter, depth, maxChars, ref_id);

    // Result is { pageContent, viewport, error? }
    if (result.error) {
      sendResponse({
        success: false,
        error: result.error,
        viewport: result.viewport,
      });
      return;
    }

    sendResponse({
      success: true,
      tree: result.pageContent,
      viewport: result.viewport,
      url: window.location.href,
      title: document.title,
    });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Handle form_input tool (async for custom dropdown polling)
 */
// eslint-disable-next-line complexity, sonarjs/cognitive-complexity, max-lines-per-function
async function handleFormInput(payload, sendResponse) {
  try {
    const { ref, value } = payload;

    // Get element by ref
    let element = null;
    if (window.__elementMap && window.__elementMap[ref]) {
      element = window.__elementMap[ref].deref() || null;
      if (element && !document.contains(element)) {
        delete window.__elementMap[ref];
        element = null;
      }
    }

    if (!element) {
      sendResponse({
        success: false,
        error: `No element found with reference: "${ref}". The element may have been removed from the page.`
      });
      return;
    }

    // Scroll element into view first
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Handle native SELECT elements — case-insensitive matching
    if (element instanceof HTMLSelectElement) {
      const prev = element.value;
      const options = Array.from(element.options);
      const valueStr = String(value);
      let found = false;

      for (let i = 0; i < options.length; i++) {
        if (options[i].value === valueStr || options[i].text === valueStr ||
            options[i].text.toLowerCase() === valueStr.toLowerCase()) {
          element.selectedIndex = i;
          found = true;
          break;
        }
      }

      if (found) {
        element.focus();
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        sendResponse({
          success: true,
          output: 'Selected "' + valueStr + '" (previous: "' + prev + '")'
        });
      } else {
        const optionsList = options.map(o => '"' + o.text + '" (value: "' + o.value + '")').join(', ');
        sendResponse({
          success: false,
          error: 'Option "' + valueStr + '" not found. Available: ' + optionsList
        });
      }
      return;
    }

    // CUSTOM DROPDOWN / COMBOBOX (React Select, MUI, Workday, etc.)
    const isCombobox = element.getAttribute('role') === 'combobox' ||
                       element.getAttribute('aria-autocomplete') === 'list';
    const comboboxAncestor = !isCombobox ? element.closest('[role="combobox"]') : null;
    const hasComboboxInput = !isCombobox && !comboboxAncestor && element.tagName !== 'INPUT'
      ? element.querySelector('input[role="combobox"], input[aria-autocomplete="list"]')
      : null;
    const haspopup = element.getAttribute('aria-haspopup');
    const isDropdownTrigger = !isCombobox && !comboboxAncestor && !hasComboboxInput &&
      (haspopup === 'listbox' || haspopup === 'true' ||
       element.getAttribute('role') === 'listbox' ||
       (element.tagName === 'BUTTON' && element.closest('[data-automation-id]') &&
        (element.querySelector('[data-automation-id*="select"]') || element.closest('[data-automation-id*="select"]') ||
         element.closest('[data-automation-id*="dropdown"]'))));

    if (isCombobox || comboboxAncestor || hasComboboxInput || isDropdownTrigger) {
      let input = null;
      let hasSearchInput = false;

      if (isDropdownTrigger) {
        element.click();
        await new Promise(r => setTimeout(r, 500));
        const popup = document.querySelector('[role="listbox"]');
        const searchInput = popup
          ? popup.querySelector('input') || popup.parentElement?.querySelector('input')
          : document.querySelector('[role="combobox"]:not([aria-hidden="true"])') ||
            document.querySelector('input[aria-activedescendant]');
        if (searchInput && searchInput instanceof HTMLInputElement) {
          input = searchInput;
          hasSearchInput = true;
        }
      } else {
        input = element;
        if (comboboxAncestor) {
          input = comboboxAncestor.querySelector('input') || comboboxAncestor;
        } else if (hasComboboxInput) {
          input = hasComboboxInput;
        } else if (element.tagName !== 'INPUT') {
          input = element.querySelector('input') || element;
        }
        hasSearchInput = input instanceof HTMLInputElement;
        input.focus();
        input.click();
        await new Promise(r => setTimeout(r, 300));
      }

      // Type search text if there's an input field
      if (hasSearchInput && input) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 100));
          nativeSetter.call(input, String(value));
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          input.value = String(value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      // Poll for dropdown options to appear (max 2s)
      // Scope query: use aria-owns/aria-controls if available, else fall back to global
      const comboEl = input || element;
      const ownedId = comboEl.getAttribute('aria-owns') || comboEl.getAttribute('aria-controls');
      let options = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(r => setTimeout(r, 200));
        const container = ownedId ? document.getElementById(ownedId) : null;
        const scope = container || document;
        options = Array.from(scope.querySelectorAll('[role="option"]:not([aria-disabled="true"])'));
        options = options.filter(o => o.offsetParent !== null || o.offsetHeight > 0);
        if (options.length > 0) break;
      }

      if (options.length === 0) {
        sendResponse({
          success: false,
          error: 'No dropdown options appeared after typing "' + value + '". Try clicking the container first, then use form_input on the input inside it.'
        });
        return;
      }

      // Multi-pass matching algorithm
      const searchStr = String(value).trim().toLowerCase();
      let matched = null;

      // Pass 1: Exact match
      for (const opt of options) {
        const text = (opt.textContent || '').trim().toLowerCase();
        if (text === searchStr) { matched = opt; break; }
      }
      // Pass 2: Option contains search string (prefer shorter = more specific)
      if (!matched) {
        let bestLen = Infinity;
        for (const opt of options) {
          const text = (opt.textContent || '').trim().toLowerCase();
          if (text.includes(searchStr) && text.length < bestLen) {
            matched = opt;
            bestLen = text.length;
          }
        }
      }
      // Pass 3: Search string contains option text (min 3 chars to avoid nonsense matches)
      if (!matched) {
        let bestLen = 0;
        for (const opt of options) {
          const text = (opt.textContent || '').trim().toLowerCase();
          if (text.length >= 3 && searchStr.includes(text) && text.length > bestLen) {
            matched = opt;
            bestLen = text.length;
          }
        }
      }
      // Pass 4: All words match
      if (!matched) {
        const words = searchStr.split(/[\s,]+/).filter(Boolean);
        if (words.length > 1) {
          for (const opt of options) {
            const text = (opt.textContent || '').trim().toLowerCase();
            if (words.every(w => text.includes(w))) { matched = opt; break; }
          }
        }
      }
      // Pass 5: Single result — just take it
      if (!matched && options.length === 1) {
        matched = options[0];
      }

      if (!matched) {
        const available = options.map(o => (o.textContent || '').trim()).filter(Boolean).slice(0, 15);
        sendResponse({
          success: false,
          error: 'No matching option for "' + value + '". Available: ' + available.join(', ')
        });
        return;
      }

      matched.scrollIntoView({ block: 'nearest' });
      matched.click();
      await new Promise(r => setTimeout(r, 300));
      sendResponse({
        success: true,
        output: 'Selected "' + (matched.textContent || '').trim() + '" from dropdown (searched: "' + value + '")'
      });
      return;
    }

    // Handle CHECKBOX inputs — use click() for React/framework compatibility (same as radio)
    if (element instanceof HTMLInputElement && element.type === 'checkbox') {
      if (typeof value !== 'boolean') {
        sendResponse({ success: false, error: 'Checkbox requires a boolean value (true/false)' });
        return;
      }
      const prev = element.checked;
      // Only click if the current state differs from desired
      if (element.checked !== value) {
        element.click();
      }
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      sendResponse({
        success: true,
        output: 'Checkbox ' + (element.checked ? 'checked' : 'unchecked') + ' (was: ' + prev + ')'
      });
      return;
    }

    // Handle RADIO inputs — use click() for React compatibility
    if (element instanceof HTMLInputElement && element.type === 'radio') {
      element.click();
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      const group = element.name ? ' in group "' + element.name + '"' : '';
      sendResponse({
        success: true,
        output: 'Radio button selected' + group
      });
      return;
    }

    // Handle DATE/TIME inputs
    if (element instanceof HTMLInputElement &&
        ['date', 'time', 'datetime-local', 'month', 'week'].includes(element.type)) {
      const prev = element.value;
      element.value = String(value);
      element.focus();
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      sendResponse({
        success: true,
        output: 'Set ' + element.type + ' to "' + element.value + '" (was: "' + prev + '")'
      });
      return;
    }

    // Handle RANGE inputs
    if (element instanceof HTMLInputElement && element.type === 'range') {
      const num = Number(value);
      if (isNaN(num)) {
        sendResponse({ success: false, error: 'Range input requires a numeric value' });
        return;
      }
      const prev = element.value;
      element.value = String(num);
      element.focus();
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      sendResponse({
        success: true,
        output: 'Set range to ' + element.value + ' (was: ' + prev + ', min: ' + element.min + ', max: ' + element.max + ')'
      });
      return;
    }

    // Handle NUMBER inputs
    if (element instanceof HTMLInputElement && element.type === 'number') {
      const num = Number(value);
      if (isNaN(num) && value !== '') {
        sendResponse({ success: false, error: 'Number input requires a numeric value' });
        return;
      }
      const prev = element.value;
      element.value = String(value);
      element.focus();
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      sendResponse({
        success: true,
        output: 'Set number to ' + element.value + ' (was: "' + prev + '")'
      });
      return;
    }

    // Handle TEXT inputs and TEXTAREAs — use native setter to bypass React
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prev = element.value;
      const proto = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(element, String(value));
      } else {
        element.value = String(value);
      }
      element.focus();
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      if ((element instanceof HTMLTextAreaElement ||
           (element instanceof HTMLInputElement &&
            ['text', 'search', 'url', 'tel', 'password', 'email'].includes(element.type))) &&
          element.setSelectionRange) {
        try { element.setSelectionRange(element.value.length, element.value.length); } catch { /* not all inputs support setSelectionRange */ }
      }
      const type = element instanceof HTMLTextAreaElement ? 'textarea' : (element.type || 'text');
      sendResponse({
        success: true,
        output: 'Set ' + type + ' to "' + element.value + '" (was: "' + prev + '")'
      });
      return;
    }

    // Handle CONTENTEDITABLE
    if (element.contentEditable === 'true' || element.isContentEditable) {
      const prev = element.textContent;
      element.textContent = String(value);
      element.focus();
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      sendResponse({
        success: true,
        output: 'Set contenteditable to "' + element.textContent + '" (was: "' + prev + '")'
      });
      return;
    }

    sendResponse({
      success: false,
      error: `Element type "${element.tagName}" is not a supported form input`
    });
  } catch (error) {
    sendResponse({
      success: false,
      error: `Error setting form value: ${error instanceof Error ? error.message : 'Unknown error'}`
    });
  }
}

/**
 * Handle getting element bounding rect
 */
function handleGetElementRect(payload, sendResponse) {
  try {
    const { ref } = payload;
    const rect = window.__getElementRect(ref);

    if (!rect) {
      sendResponse({ success: false, error: `Element ${ref} not found` });
      return;
    }

    sendResponse({ success: true, rect });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Handle get element selector - returns a unique CSS selector for an element
 */
function handleGetElementSelector(payload, sendResponse) {
  try {
    const { ref } = payload;
    const element = window.__getElementByRef(ref);

    if (!element) {
      sendResponse({ success: false, error: `Element ${ref} not found` });
      return;
    }

    // Generate a unique CSS selector for the element
    const selector = generateUniqueSelector(element);
    sendResponse({ success: true, selector });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Generate a unique CSS selector for an element
 */
function generateUniqueSelector(element) {
  // If element has an ID, use it
  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }

  // Build a path-based selector
  const path = [];
  let current = element;

  while (current && current !== document.body && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();

    // Add class names if present
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/).filter(c => c);
      if (classes.length > 0) {
        selector += '.' + classes.map(c => CSS.escape(c)).join('.');
      }
    }

    // Add nth-child if needed for uniqueness
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        child => child.tagName === current.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }

    path.unshift(selector);
    current = current.parentElement;

    // Check if current path uniquely identifies the element
    const testSelector = path.join(' > ');
    const matches = document.querySelectorAll(testSelector);
    if (matches.length === 1 && matches[0] === element) {
      return testSelector;
    }
  }

  return path.join(' > ');
}

/**
 * Handle scroll to element
 */
function handleScrollToRef(payload, sendResponse) {
  try {
    const { ref } = payload;
    const element = window.__getElementByRef(ref);

    if (!element) {
      sendResponse({ success: false, error: `Element ${ref} not found` });
      return;
    }

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Handle direct click on element by ref
 */
function handleClickRef(payload, sendResponse) {
  try {
    const { ref } = payload;
    const element = window.__getElementByRef(ref);

    if (!element) {
      sendResponse({ success: false, error: `Element ${ref} not found` });
      return;
    }

    // Scroll into view
    element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });

    // Force reflow
    if (element instanceof HTMLElement) {
      void element.offsetHeight;
    }

    element.focus();
    element.click();
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Handle get_page_text tool
 */
function handleGetPageText(sendResponse) {
  try {
    // Get main content, fallback to body
    const main = document.querySelector('main, article, [role="main"]') || document.body;

    // Clone and remove scripts, styles, etc.
    const clone = main.cloneNode(true);
    const removeSelectors = ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside'];
    removeSelectors.forEach(sel => {
      clone.querySelectorAll(sel).forEach(el => el.remove());
    });

    const text = clone.textContent
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 50000);

    sendResponse({
      success: true,
      text,
      url: window.location.href,
      title: document.title,
    });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Handle scroll_to action
 */
function handleScrollToElement(payload, sendResponse) {
  try {
    const { ref } = payload;

    let element = null;
    if (window.__elementMap && window.__elementMap[ref]) {
      element = window.__elementMap[ref].deref() || null;
      if (element && !document.contains(element)) {
        delete window.__elementMap[ref];
        element = null;
      }
    }

    if (!element) {
      sendResponse({ success: false, error: `Element ${ref} not found` });
      return;
    }

    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Handle upload_image tool
 */
function handleUploadImage(payload, sendResponse) {
  try {
    const { dataUrl, ref, coordinate, filename } = payload;

    // Convert data URL to blob
    const [header, base64] = dataUrl.split(',');
    const mimeType = header.match(/:(.*?);/)?.[1] || 'image/png';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });
    const file = new File([blob], filename || 'image.png', { type: mimeType });

    // If ref is provided, upload to file input
    if (ref) {
      let element = null;
      if (window.__elementMap && window.__elementMap[ref]) {
        element = window.__elementMap[ref].deref() || null;
        if (element && !document.contains(element)) {
          delete window.__elementMap[ref];
          element = null;
        }
      }

      if (!element) {
        sendResponse({ success: false, error: `Element ${ref} not found` });
        return;
      }

      if (element.tagName !== 'INPUT' || element.type !== 'file') {
        sendResponse({ success: false, error: `Element ${ref} is not a file input` });
        return;
      }

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      element.files = dataTransfer.files;
      element.dispatchEvent(new Event('change', { bubbles: true }));

      sendResponse({ success: true, output: `Uploaded ${filename} to file input` });
      return;
    }

    // If coordinate is provided, simulate drag & drop
    if (coordinate) {
      const [x, y] = coordinate;
      const target = document.elementFromPoint(x, y);

      if (!target) {
        sendResponse({ success: false, error: `No element found at (${x}, ${y})` });
        return;
      }

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: x,
        clientY: y,
      });

      target.dispatchEvent(dropEvent);
      sendResponse({ success: true, output: `Dropped ${filename} at (${x}, ${y})` });
      return;
    }

    sendResponse({ success: false, error: 'Either ref or coordinate is required' });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

/**
 * Find scrollable container at coordinates and scroll it
 * Checks overflowY/X for "auto" or "scroll" to find scrollable parents
 */
function handleFindAndScroll(payload, sendResponse) {
  try {
    const { x, y, deltaX, deltaY, direction: _direction, amount: _amount } = payload;

    // Helper to check if element is scrollable
    // eslint-disable-next-line no-inner-declarations
    function isScrollable(element) {
      const style = window.getComputedStyle(element);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const isScrollableY = (overflowY === 'auto' || overflowY === 'scroll') &&
                            element.scrollHeight > element.clientHeight;
      const isScrollableX = (overflowX === 'auto' || overflowX === 'scroll') &&
                            element.scrollWidth > element.clientWidth;
      return isScrollableY || isScrollableX;
    }

    // Find element at coordinates
    const elementAtPoint = document.elementFromPoint(x, y);
    if (!elementAtPoint) {
      sendResponse({ scrolledContainer: false });
      return;
    }

    // Walk up the DOM to find scrollable container
    let scrollContainer = elementAtPoint;
    while (scrollContainer && scrollContainer !== document.body && scrollContainer !== document.documentElement) {
      if (isScrollable(scrollContainer)) {
        break;
      }
      scrollContainer = scrollContainer.parentElement;
    }

    // If we found a scrollable container (not body/html), scroll it
    // Use behavior: "instant" for immediate scroll
    if (scrollContainer && scrollContainer !== document.body && scrollContainer !== document.documentElement && isScrollable(scrollContainer)) {
      scrollContainer.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
      sendResponse({
        scrolledContainer: true,
        containerType: scrollContainer.tagName.toLowerCase(),
      });
      return;
    }

    // Fallback: scroll the window itself
    window.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
    sendResponse({ scrolledContainer: true, containerType: 'window' });
  } catch (error) {
    sendResponse({ scrolledContainer: false, error: error.message });
  }
}

// ─── Dashboard ↔ Extension Bridge ────────────────────────────────────
// Allows the developer console (web page) to pair this browser with one click.
// The page sends a postMessage, the content script relays it to the service worker.

// Guard: only the first content script instance handles pairing messages
if (!window.__hanziPairListenerAttached) {
  window.__hanziPairListenerAttached = true;
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    // HANZI_SET_SESSION: page already called register, just pass credentials to service worker
    if (event.data?.type === 'HANZI_SET_SESSION') {
      const { sessionToken, browserSessionId, relayUrl } = event.data;
      if (!sessionToken) return;
      chrome.runtime.sendMessage({
        type: 'MANAGED_SET_SESSION',
        payload: { session_token: sessionToken, browser_session_id: browserSessionId, relay_url: relayUrl },
      }, (response) => {
        window.postMessage({ type: 'HANZI_SESSION_SET', success: response?.success || false }, '*');
      });
    }

    // HANZI_PAIR: legacy path used by embed widget (3rd-party pages can't call API directly)
    if (event.data?.type === 'HANZI_PAIR') {
      const { token, apiUrl } = event.data;
      if (!token) return;
      chrome.runtime.sendMessage({
        type: 'MANAGED_PAIR',
        payload: { pairing_token: token, api_url: apiUrl || window.location.origin },
      }, (response) => {
        window.postMessage({
          type: 'HANZI_PAIR_RESULT',
          success: response?.success || false,
          browserSessionId: response?.browserSessionId,
          error: response?.error,
        }, '*');
      });
    }
  });
}

// Respond to extension detection pings
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type === 'HANZI_PING') {
    window.postMessage({ type: 'HANZI_EXTENSION_READY' }, '*');
  }
});

// Also broadcast once on load (for pages that loaded before the listener was set up)
window.postMessage({ type: 'HANZI_EXTENSION_READY' }, '*');

console.log('[Hanzi Browse] Content script loaded');
