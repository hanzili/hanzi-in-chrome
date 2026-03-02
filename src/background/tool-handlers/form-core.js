/**
 * Form input tool handler
 * Supports native <select>, custom dropdowns (React Select, MUI, Workday), and all standard inputs.
 *
 * Two element resolution paths:
 * - CDP backendNodeId (numeric refs from read_page): resolved via DOM.resolveNode
 * - Legacy ref_N (from content script find): resolved via WeakRef in content script
 */

import { ensureDebugger, sendDebuggerCommand } from '../managers/debugger-manager.js';
import { createElementResolver } from '../dom-service/element-resolver.js';

const elementResolver = createElementResolver(sendDebuggerCommand);

/**
 * The form manipulation function body.
 * Runs in page context via Runtime.callFunctionOn (CDP path).
 * First argument is the element (resolved from objectId), second is the value.
 */
const FORM_MANIPULATION_FN = `async (el, value) => {
  try {
    if (!el || !document.contains(el)) {
      return { error: 'Element has been removed from the page.' };
    }
    if (!(el instanceof Element)) {
      return { error: 'Reference resolved to a non-element node (type: ' + el.nodeType + '). Use read_page to get a valid element ref.' };
    }

    if (el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "center" });

    // SELECT element (native)
    if (el instanceof HTMLSelectElement) {
      const prev = el.value;
      const options = Array.from(el.options);
      const valueStr = String(value);
      let found = false;
      for (let i = 0; i < options.length; i++) {
        if (options[i].value === valueStr || options[i].text === valueStr ||
            options[i].text.toLowerCase() === valueStr.toLowerCase()) {
          el.selectedIndex = i;
          found = true;
          break;
        }
      }
      if (!found) {
        return { error: 'Option "' + valueStr + '" not found. Available: ' +
          options.map(o => '"' + o.text + '" (value: "' + o.value + '")').join(', ') };
      }
      el.focus();
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      return { output: 'Selected "' + valueStr + '" (previous: "' + prev + '")' };
    }

    // CUSTOM DROPDOWN / COMBOBOX
    const isCombobox = el.getAttribute('role') === 'combobox' ||
                       el.getAttribute('aria-autocomplete') === 'list';
    const comboboxAncestor = !isCombobox ? el.closest('[role="combobox"]') : null;
    const hasComboboxInput = !isCombobox && !comboboxAncestor && el.tagName !== 'INPUT'
      ? el.querySelector('input[role="combobox"], input[aria-autocomplete="list"]')
      : null;
    const haspopup = el.getAttribute('aria-haspopup');
    const isDropdownTrigger = !isCombobox && !comboboxAncestor && !hasComboboxInput &&
      (haspopup === 'listbox' || haspopup === 'true' ||
       el.getAttribute('role') === 'listbox' ||
       (el.tagName === 'BUTTON' && el.closest('[data-automation-id]') &&
        (el.querySelector('[data-automation-id*="select"]') || el.closest('[data-automation-id*="select"]') ||
         el.closest('[data-automation-id*="dropdown"]'))));

    if (isCombobox || comboboxAncestor || hasComboboxInput || isDropdownTrigger) {
      let inp = null;
      let hasSearchInput = false;

      if (isDropdownTrigger) {
        el.click();
        await new Promise(r => setTimeout(r, 500));
        const popup = document.querySelector('[role="listbox"]');
        const searchInput = popup
          ? popup.querySelector('input') || popup.parentElement?.querySelector('input')
          : document.querySelector('[role="combobox"]:not([aria-hidden="true"])') ||
            document.querySelector('input[aria-activedescendant]');
        if (searchInput && searchInput instanceof HTMLInputElement) {
          inp = searchInput;
          hasSearchInput = true;
        }
      } else {
        inp = el;
        if (comboboxAncestor) {
          inp = comboboxAncestor.querySelector('input') || comboboxAncestor;
        } else if (hasComboboxInput) {
          inp = hasComboboxInput;
        } else if (el.tagName !== 'INPUT') {
          inp = el.querySelector('input') || el;
        }
        hasSearchInput = inp instanceof HTMLInputElement;
        inp.focus();
        inp.click();
        await new Promise(r => setTimeout(r, 300));
      }

      if (hasSearchInput && inp) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(inp, '');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 100));
          nativeSetter.call(inp, String(value));
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          inp.value = String(value);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      const comboEl = inp || el;
      const ownedId = comboEl.getAttribute('aria-owns') || comboEl.getAttribute('aria-controls');
      let ddOptions = [];
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(r => setTimeout(r, 200));
        const container = ownedId ? document.getElementById(ownedId) : null;
        const scope = container || document;
        ddOptions = Array.from(scope.querySelectorAll('[role="option"]:not([aria-disabled="true"])'));
        ddOptions = ddOptions.filter(o => o.offsetParent !== null || o.offsetHeight > 0);
        if (ddOptions.length > 0) break;
      }

      if (ddOptions.length === 0) {
        return { error: 'No dropdown options appeared after typing "' + value + '". Try clicking the container first, then use form_input on the input inside it.' };
      }

      const searchStr = String(value).trim().toLowerCase();
      let matched = null;
      for (const opt of ddOptions) {
        if ((opt.textContent || '').trim().toLowerCase() === searchStr) { matched = opt; break; }
      }
      if (!matched) {
        let bestLen = Infinity;
        for (const opt of ddOptions) {
          const text = (opt.textContent || '').trim().toLowerCase();
          if (text.includes(searchStr) && text.length < bestLen) { matched = opt; bestLen = text.length; }
        }
      }
      if (!matched) {
        let bestLen2 = 0;
        for (const opt of ddOptions) {
          const text = (opt.textContent || '').trim().toLowerCase();
          if (text.length >= 3 && searchStr.includes(text) && text.length > bestLen2) { matched = opt; bestLen2 = text.length; }
        }
      }
      if (!matched) {
        const words = searchStr.split(/[\\s,]+/).filter(Boolean);
        if (words.length > 1) {
          for (const opt of ddOptions) {
            const text = (opt.textContent || '').trim().toLowerCase();
            if (words.every(w => text.includes(w))) { matched = opt; break; }
          }
        }
      }
      if (!matched && ddOptions.length === 1) matched = ddOptions[0];

      if (!matched) {
        const available = ddOptions.map(o => (o.textContent || '').trim()).filter(Boolean).slice(0, 15);
        return { error: 'No matching option for "' + value + '". Available: ' + available.join(', ') };
      }

      matched.scrollIntoView({ block: 'nearest' });
      matched.click();
      await new Promise(r => setTimeout(r, 300));
      return { output: 'Selected "' + (matched.textContent || '').trim() + '" from dropdown (searched: "' + value + '")' };
    }

    // CHECKBOX
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      if (typeof value !== "boolean") return { error: "Checkbox requires a boolean value (true/false)" };
      const prev = el.checked;
      if (el.checked !== value) el.click();
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { output: 'Checkbox ' + (el.checked ? 'checked' : 'unchecked') + ' (was: ' + prev + ')' };
    }

    // RADIO
    if (el instanceof HTMLInputElement && el.type === "radio") {
      el.click();
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      const group = el.name ? ' in group "' + el.name + '"' : '';
      return { output: 'Radio button selected' + group };
    }

    // DATE/TIME
    if (el instanceof HTMLInputElement &&
        ["date", "time", "datetime-local", "month", "week"].includes(el.type)) {
      const prev = el.value;
      el.value = String(value);
      el.focus();
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { output: 'Set ' + el.type + ' to "' + el.value + '" (was: "' + prev + '")' };
    }

    // RANGE
    if (el instanceof HTMLInputElement && el.type === "range") {
      const num = Number(value);
      if (isNaN(num)) return { error: "Range input requires numeric value" };
      const prev = el.value;
      el.value = String(num);
      el.focus();
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { output: 'Set range to ' + el.value + ' (was: ' + prev + ', min: ' + el.min + ', max: ' + el.max + ')' };
    }

    // NUMBER
    if (el instanceof HTMLInputElement && el.type === "number") {
      const num = Number(value);
      if (isNaN(num) && value !== "") return { error: "Number input requires numeric value" };
      const prev = el.value;
      el.value = String(value);
      el.focus();
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { output: 'Set number to ' + el.value + ' (was: "' + prev + '")' };
    }

    // TEXT INPUT and TEXTAREA
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const prev = el.value;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) { nativeSetter.call(el, String(value)); } else { el.value = String(value); }
      el.focus();
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      if ((el instanceof HTMLTextAreaElement ||
           (el instanceof HTMLInputElement &&
            ["text", "search", "url", "tel", "password", "email"].includes(el.type))) &&
          el.setSelectionRange) {
        try { el.setSelectionRange(el.value.length, el.value.length); } catch(e) {}
      }
      const type = el instanceof HTMLTextAreaElement ? 'textarea' : (el.type || 'text');
      return { output: 'Set ' + type + ' to "' + el.value + '" (was: "' + prev + '")' };
    }

    // CONTENTEDITABLE
    if (el.contentEditable === 'true' || el.isContentEditable) {
      const prev = el.textContent;
      el.textContent = String(value);
      el.focus();
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      return { output: 'Set contenteditable to "' + el.textContent + '" (was: "' + prev + '")' };
    }

    return { error: 'Element type "' + el.tagName + '" is not a supported form input' };
  } catch (err) {
    return { error: 'Error setting form value: ' + (err.message || 'Unknown error') };
  }
}`;

/**
 * Handle form_input tool - set form element values using ref
 *
 * @param {Object} input - Tool input
 * @param {string|number} input.ref - Element reference (numeric backendNodeId or "ref_N")
 * @param {string|boolean|number} input.value - Value to set
 * @param {number} input.tabId - Tab ID
 * @returns {Promise<{output?: string, error?: string}>}
 */
export async function handleFormInput(input) {
  try {
    if (!input?.ref) {
      throw new Error("ref parameter is required");
    }
    if (input.value === undefined || input.value === null) {
      throw new Error("Value parameter is required");
    }
    if (!input.tabId) {
      throw new Error("No active tab found");
    }

    const tabId = input.tabId;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.id) {
      throw new Error("Active tab has no ID");
    }

    // CDP path: numeric backendNodeId (from read_page)
    const backendNodeId = elementResolver.parseRef(input.ref);
    if (backendNodeId) {
      try {
        await ensureDebugger(tabId);
        const result = await elementResolver.callFunction(
          tabId,
          backendNodeId,
          FORM_MANIPULATION_FN,
          [{ value: input.value }],
        );
        return result || { error: 'No result from form manipulation' };
      } catch (err) {
        return { error: `Form input failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
      }
    }

    // Legacy path: ref_N format via content script WeakRef
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'ISOLATED',
      func: async (ref, value) => {
        try {
          let element = null;
          if (window.__elementRefMap && window.__elementRefMap[ref]) {
            element = window.__elementRefMap[ref].deref() || null;
            if (!element || !document.contains(element)) {
              delete window.__elementRefMap[ref];
              element = null;
            }
          }
          if (!element) {
            return { error: 'No element found with reference: "' + ref + '". The element may have been removed from the page.' };
          }
          element.scrollIntoView({ behavior: "smooth", block: "center" });

          // SELECT
          if (element instanceof HTMLSelectElement) {
            const prev = element.value;
            const options = Array.from(element.options);
            const valueStr = String(value);
            let found = false;
            for (let i = 0; i < options.length; i++) {
              if (options[i].value === valueStr || options[i].text === valueStr ||
                  options[i].text.toLowerCase() === valueStr.toLowerCase()) {
                element.selectedIndex = i; found = true; break;
              }
            }
            if (!found) return { error: 'Option "' + valueStr + '" not found. Available: ' + options.map(o => '"' + o.text + '" (value: "' + o.value + '")').join(', ') };
            element.focus();
            element.dispatchEvent(new Event("change", { bubbles: true }));
            element.dispatchEvent(new Event("input", { bubbles: true }));
            return { output: 'Selected "' + valueStr + '" (previous: "' + prev + '")' };
          }

          // CHECKBOX
          if (element instanceof HTMLInputElement && element.type === "checkbox") {
            if (typeof value !== "boolean") return { error: "Checkbox requires boolean" };
            const prev = element.checked;
            if (element.checked !== value) element.click();
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return { output: 'Checkbox ' + (element.checked ? 'checked' : 'unchecked') + ' (was: ' + prev + ')' };
          }

          // RADIO
          if (element instanceof HTMLInputElement && element.type === "radio") {
            element.click();
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return { output: 'Radio button selected' + (element.name ? ' in group "' + element.name + '"' : '') };
          }

          // TEXT INPUT, TEXTAREA, NUMBER, DATE, RANGE, CONTENTEDITABLE
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            const prev = element.value;
            const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (nativeSetter) nativeSetter.call(element, String(value));
            else element.value = String(value);
            element.focus();
            element.dispatchEvent(new Event("input", { bubbles: true }));
            element.dispatchEvent(new Event("change", { bubbles: true }));
            const type = element instanceof HTMLTextAreaElement ? 'textarea' : (element.type || 'text');
            return { output: 'Set ' + type + ' to "' + element.value + '" (was: "' + prev + '")' };
          }

          if (element.contentEditable === 'true' || element.isContentEditable) {
            const prev = element.textContent;
            element.textContent = String(value);
            element.focus();
            element.dispatchEvent(new Event("input", { bubbles: true }));
            return { output: 'Set contenteditable to "' + element.textContent + '" (was: "' + prev + '")' };
          }

          return { error: 'Element type "' + element.tagName + '" is not a supported form input' };
        } catch (err) {
          return { error: 'Error setting form value: ' + (err instanceof Error ? err.message : 'Unknown error') };
        }
      },
      args: [input.ref, input.value],
    });

    if (!result || result.length === 0) {
      throw new Error("Failed to execute form input");
    }

    return result[0].result;
  } catch (err) {
    return {
      error: `Failed to execute form input: ${err instanceof Error ? err.message : "Unknown error"}`,
    };
  }
}
