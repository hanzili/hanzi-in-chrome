/**
 * DOM Tree Serializer
 *
 * Filters enhanced DOM tree and serializes to text format for LLM consumption.
 * Produces output matching browser-use's DOMTreeSerializer format:
 *   [backendNodeId]<tag attr1=val1 attr2=val2 />
 *   Visible text content
 *   |SHADOW(open)|[id]<input ... />
 *
 * Port of browser-use's serializer/serializer.py + clickable_elements.py
 */

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;
const NODE_DOCUMENT = 9;
const NODE_DOCUMENT_FRAGMENT = 11;

const DISABLED_ELEMENTS = new Set([
  'STYLE', 'SCRIPT', 'HEAD', 'META', 'LINK', 'TITLE', 'NOSCRIPT',
]);

const SVG_CHILD_ELEMENTS = new Set([
  'path', 'rect', 'g', 'circle', 'ellipse', 'line', 'polyline',
  'polygon', 'use', 'defs', 'clipPath', 'mask', 'pattern', 'image',
  'text', 'tspan',
]);

const INTERACTIVE_TAGS = new Set([
  'button', 'input', 'select', 'textarea', 'a', 'details', 'summary',
  'option', 'optgroup',
]);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'menuitem', 'option', 'radio', 'checkbox', 'tab',
  'textbox', 'combobox', 'slider', 'spinbutton', 'search', 'searchbox',
  'listbox', 'row', 'cell', 'gridcell', 'separator',
]);

// Attributes to include in serialized output (matching browser-use DEFAULT_INCLUDE_ATTRIBUTES)
// Extended with data-automation-id, class, data-testid, href — these help the AI
// write targeted JavaScript selectors when form_input/click doesn't work.
const INCLUDE_ATTRIBUTES = new Set([
  'title', 'type', 'checked', 'id', 'name', 'role', 'value',
  'placeholder', 'alt', 'aria-label', 'aria-expanded', 'data-state',
  'aria-checked', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow',
  'pattern', 'min', 'max', 'minlength', 'maxlength', 'step', 'accept',
  'multiple', 'inputmode', 'autocomplete', 'aria-autocomplete',
  'contenteditable', 'required',
  // Selector hints — help AI write targeted JS when standard tools fail
  'class', 'href', 'for', 'data-automation-id', 'data-testid',
]);

// AX properties to include
const INCLUDE_AX_PROPS = new Set([
  'checked', 'selected', 'expanded', 'pressed', 'disabled', 'invalid',
  'valuemin', 'valuemax', 'valuenow', 'required', 'valuetext',
  'haspopup', 'multiselectable', 'level',
]);

/**
 * Check if an enhanced node is interactive/clickable.
 * Port of browser-use's ClickableElementDetector.is_interactive()
 *
 * Must also be visible to be included in the selector map.
 */
function isInteractive(node) {
  if (node.nodeType !== NODE_ELEMENT) return false;

  const tag = (node.nodeName || '').toLowerCase();
  if (tag === 'html' || tag === 'body') return false;

  // Must be visible (have bounds and not hidden by CSS)
  // Exception: file inputs which may have 0-size but are still interactive
  if (!node.isVisible && tag !== 'input') return false;

  // Interactive tags
  if (INTERACTIVE_TAGS.has(tag)) return true;

  // Interactive ARIA roles (from HTML attributes)
  const role = node.attributes?.role;
  if (role && INTERACTIVE_ROLES.has(role)) return true;

  // Interactive AX roles — but NOT for generic structural elements
  // (LI, UL, DIV with listitem/list/generic roles are not truly interactive)
  if (node.axNode?.role) {
    const axRole = node.axNode.role;
    if (INTERACTIVE_ROLES.has(axRole) && axRole !== 'listbox' && axRole !== 'list') {
      return true;
    }
  }

  // Interactive attributes (onclick, tabindex, etc.)
  if (node.attributes) {
    const interactiveAttrs = ['onclick', 'onmousedown', 'onmouseup', 'tabindex'];
    for (const attr of interactiveAttrs) {
      if (attr in node.attributes) return true;
    }
  }

  // AX properties indicating interactivity
  if (node.axNode?.properties) {
    const props = node.axNode.properties;
    if (props.focusable || props.editable || props.settable) return true;
    if ('checked' in props || 'expanded' in props || 'pressed' in props) return true;
  }

  // Cursor pointer
  if (node.snapshotNode?.cursorStyle === 'pointer') return true;

  return false;
}

/**
 * Check if an element should be included in the simplified tree.
 */
function shouldInclude(node) {
  const tag = (node.nodeName || '').toUpperCase();

  // Always skip disabled elements
  if (DISABLED_ELEMENTS.has(tag)) return false;

  // Skip SVG child elements (only show <svg> itself)
  if (SVG_CHILD_ELEMENTS.has(tag.toLowerCase())) return false;

  // Skip extension overlay elements (Simplify, etc.) — they waste agent turns
  const cls = node.attributes?.class || '';
  if (cls.includes('simplify')) return false;

  // Include if visible, has snapshot data, or is interactive
  if (node.isVisible) return true;
  if (isInteractive(node)) return true;

  // Include shadow hosts (they contain shadow roots we need to traverse)
  if (node.shadowRoots && node.shadowRoots.length > 0) return true;

  // Include elements with children (structural)
  if (node.children && node.children.length > 0) return true;
  if (node.contentDocument) return true;

  return false;
}

/**
 * Build attributes string for an element.
 * Mirrors browser-use's _build_attributes_string()
 */
function buildAttributesString(node) {
  const attrs = {};

  // HTML attributes
  if (node.attributes) {
    for (const [key, value] of Object.entries(node.attributes)) {
      if (INCLUDE_ATTRIBUTES.has(key) && value != null && String(value).trim() !== '') {
        attrs[key] = String(value).trim();
      }
    }
  }

  // AX properties
  if (node.axNode?.properties) {
    for (const [propName, propValue] of Object.entries(node.axNode.properties)) {
      if (INCLUDE_AX_PROPS.has(propName) && propValue != null) {
        const strVal = typeof propValue === 'boolean'
          ? String(propValue).toLowerCase()
          : String(propValue).trim();
        if (strVal) attrs[propName] = strVal;
      }
    }
  }

  // AX node value for form elements (reflects actual typed value)
  if (node.axNode && ['input', 'textarea', 'select'].includes((node.nodeName || '').toLowerCase())) {
    if (node.axNode.properties) {
      const valuetext = node.axNode.properties.valuetext;
      const value = node.axNode.properties.value;
      if (valuetext && String(valuetext).trim()) {
        attrs.value = String(valuetext).trim();
      } else if (value && String(value).trim()) {
        attrs.value = String(value).trim();
      }
    }
  }

  // Remove invalid=false, required=false
  if (attrs.invalid === 'false') delete attrs.invalid;
  if (attrs.required === 'false' || attrs.required === '0' || attrs.required === 'no') delete attrs.required;

  // Remove aria-expanded if we have expanded
  if ('expanded' in attrs && 'aria-expanded' in attrs) delete attrs['aria-expanded'];

  // Remove type if it matches tag name
  if (attrs.type && attrs.type.toLowerCase() === (node.nodeName || '').toLowerCase()) delete attrs.type;

  const parts = [];
  for (const [key, value] of Object.entries(attrs)) {
    // Cap class at 60 chars (mostly noise from CSS modules), others at 100
    const maxLen = key === 'class' ? 60 : 100;
    const capped = value.length > maxLen ? value.slice(0, maxLen) + '...' : value;
    parts.push(`${key}=${capped}`);
  }
  return parts.join(' ');
}

/**
 * Serialize enhanced DOM tree to text format.
 *
 * @param {import('./tree-builder.js').EnhancedNode} root
 * @param {Object} [options]
 * @param {number} [options.maxChars=40000] - Cap output at this many characters
 * @returns {{ text: string, selectorMap: Map<number, Object> }}
 */
export function serializeDomTree(root, options = {}) {
  const { maxChars = 40000 } = options;
  const selectorMap = new Map();
  const lines = [];
  let charCount = 0;
  let truncated = false;

  function serialize(node, depth) {
    if (!node || truncated) return;
    if (charCount > maxChars) { truncated = true; return; }

    const tag = (node.nodeName || '').toUpperCase();
    const indent = '\t'.repeat(depth);

    // Document nodes (type 9) and DocumentType nodes (type 10) — just traverse children
    if (node.nodeType === NODE_DOCUMENT || node.nodeType === 10) {
      traverseChildren(node, depth);
      return;
    }

    if (node.nodeType === NODE_ELEMENT) {
      // Skip disabled elements
      if (DISABLED_ELEMENTS.has(tag)) return;
      // Skip SVG children
      if (SVG_CHILD_ELEMENTS.has(tag.toLowerCase())) return;
      // Skip extension overlay elements (Simplify, etc.)
      const cls = node.attributes?.class || '';
      if (cls.includes('simplify')) return;

      const interactive = isInteractive(node);
      const isShadowHost = node.shadowRoots && node.shadowRoots.length > 0;
      const isIframe = tag === 'IFRAME' || tag === 'FRAME';

      // SVG — collapse children
      if (tag === 'SVG') {
        let line = indent;
        if (isShadowHost) line += '|SHADOW(open)|';
        if (interactive) {
          line += `[${node.backendNodeId}]`;
          selectorMap.set(node.backendNodeId, node);
        }
        line += '<svg';
        const attrStr = buildAttributesString(node);
        if (attrStr) line += ' ' + attrStr;
        line += ' /> <!-- SVG content collapsed -->';
        lines.push(line);
        charCount += line.length + 1;
        return;
      }

      // Determine if this element gets its own line
      const shouldShow = interactive || isShadowHost || isIframe || shouldInclude(node);
      if (!shouldShow && !node.isVisible) {
        // Still traverse children in case they're visible
        traverseChildren(node, depth);
        return;
      }

      // Build the element line
      if (interactive || isIframe) {
        let line = indent;

        // Shadow host prefix
        if (isShadowHost) {
          const hasClosed = node.shadowRoots.some(sr =>
            sr.shadowRootType && sr.shadowRootType.toLowerCase() === 'closed'
          );
          line += hasClosed ? '|SHADOW(closed)|' : '|SHADOW(open)|';
        }

        if (interactive) {
          line += `[${node.backendNodeId}]`;
          selectorMap.set(node.backendNodeId, node);
        } else if (isIframe) {
          line += '|IFRAME|';
        }

        line += `<${node.nodeName.toLowerCase()}`;
        const attrStr = buildAttributesString(node);
        if (attrStr) line += ' ' + attrStr;
        line += ' />';
        lines.push(line);
        charCount += line.length + 1;

        traverseChildren(node, depth + 1);
      } else {
        // Non-interactive structural element — don't render it, just traverse children
        traverseChildren(node, depth);
      }
    } else if (node.nodeType === NODE_TEXT) {
      // Text node
      if (node.isVisible && node.nodeValue && node.nodeValue.trim().length > 1) {
        const text = node.nodeValue.trim();
        const line = indent + text;
        lines.push(line);
        charCount += line.length + 1;
      }
    } else if (node.nodeType === NODE_DOCUMENT_FRAGMENT) {
      // Shadow root
      const isClosed = node.shadowRootType && node.shadowRootType.toLowerCase() === 'closed';
      lines.push(`${indent}${isClosed ? 'Closed Shadow' : 'Open Shadow'}`);
      charCount += indent.length + 15;

      traverseChildren(node, depth + 1);

      if (node.children && node.children.length > 0) {
        lines.push(`${indent}Shadow End`);
        charCount += indent.length + 11;
      }
    }
  }

  function traverseChildren(node, depth) {
    // Shadow roots first
    if (node.shadowRoots) {
      for (const sr of node.shadowRoots) {
        serialize(sr, depth);
      }
    }
    // Regular children
    if (node.children) {
      for (const child of node.children) {
        serialize(child, depth);
      }
    }
    // Content document (iframes)
    if (node.contentDocument) {
      serialize(node.contentDocument, depth);
    }
  }

  serialize(root, 0);

  return {
    text: lines.join('\n'),
    selectorMap,
    truncated,
  };
}
