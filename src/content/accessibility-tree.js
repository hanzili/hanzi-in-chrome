/**
 * Accessibility Tree Generator
 *
 * Generates a semantic tree representation of the page for AI navigation.
 * Uses accessibility roles instead of HTML tags for reliable element targeting.
 */

// Global state for element tracking
// Element reference map for tool handlers
window.__elementRefMap || (window.__elementRefMap = {});
window.__refCounter || (window.__refCounter = 0);

/**
 * Get element's ARIA role or infer from tag
 */
function getRole(element) {
  var role = element.getAttribute("role");
  if (role) return role;

  var tag = element.tagName.toLowerCase();
  var type = element.getAttribute("type");

  return {
    a: "link",
    button: "button",
    input: "submit" === type || "button" === type ? "button"
         : "checkbox" === type ? "checkbox"
         : "radio" === type ? "radio"
         : "file" === type ? "button"
         : "textbox",
    select: "combobox",
    textarea: "textbox",
    h1: "heading", h2: "heading", h3: "heading",
    h4: "heading", h5: "heading", h6: "heading",
    img: "image",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    section: "region",
    article: "article",
    aside: "complementary",
    form: "form",
    table: "table",
    ul: "list",
    ol: "list",
    li: "listitem",
    label: "label"
  }[tag] || "generic";
}

/**
 * Get element's accessible name (label)
 */
function getName(element) {
  var tag = element.tagName.toLowerCase();

  // For select, get selected option text
  if ("select" === tag) {
    var select = element;
    var option = select.querySelector("option[selected]") || select.options[select.selectedIndex];
    if (option && option.textContent) return option.textContent.trim();
  }

  // Try aria-label
  var ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  // Try placeholder
  var placeholder = element.getAttribute("placeholder");
  if (placeholder && placeholder.trim()) return placeholder.trim();

  // Try title
  var title = element.getAttribute("title");
  if (title && title.trim()) return title.trim();

  // Try alt (for images)
  var alt = element.getAttribute("alt");
  if (alt && alt.trim()) return alt.trim();

  // Try associated label
  if (element.id) {
    var label = document.querySelector('label[for="' + element.id + '"]');
    if (label && label.textContent && label.textContent.trim())
      return label.textContent.trim();
  }

  // For inputs, get value
  if ("input" === tag) {
    var input = element;
    var inputType = element.getAttribute("type") || "";
    var value = element.getAttribute("value");
    if ("submit" === inputType && value && value.trim()) return value.trim();
    if (input.value && input.value.length < 50 && input.value.trim())
      return input.value.trim();
  }

  // For buttons/links, get direct text content
  if (["button", "a", "summary"].includes(tag)) {
    var text = "";
    for (var i = 0; i < element.childNodes.length; i++) {
      var child = element.childNodes[i];
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
    }
    if (text.trim()) return text.trim();
  }

  // For headings, get text content
  if (tag.match(/^h[1-6]$/)) {
    var headingText = element.textContent;
    if (headingText && headingText.trim())
      return headingText.trim().substring(0, 100);
  }

  // Skip images
  if ("img" === tag) return "";

  // Get any direct text content
  var directText = "";
  for (var j = 0; j < element.childNodes.length; j++) {
    var node = element.childNodes[j];
    if (node.nodeType === Node.TEXT_NODE) directText += node.textContent;
  }
  // Minimum 2 chars filters single-char noise (bullets, icons) while keeping "No", "OK", "Go"
  if (directText && directText.trim() && directText.trim().length >= 2) {
    var trimmed = directText.trim();
    return trimmed.length > 100 ? trimmed.substring(0, 100) + "..." : trimmed;
  }

  return "";
}

/**
 * Check if element is visible
 */
function isVisible(element) {
  var style = window.getComputedStyle(element);
  return "none" !== style.display &&
         "hidden" !== style.visibility &&
         "0" !== style.opacity &&
         element.offsetWidth > 0 &&
         element.offsetHeight > 0;
}

/**
 * Check if element is interactive
 */
function isInteractive(element) {
  var tag = element.tagName.toLowerCase();
  return ["a", "button", "input", "select", "textarea", "details", "summary"].includes(tag) ||
         null !== element.getAttribute("onclick") ||
         null !== element.getAttribute("tabindex") ||
         "button" === element.getAttribute("role") ||
         "link" === element.getAttribute("role") ||
         "true" === element.getAttribute("contenteditable");
}

/**
 * Check if element has semantic role
 */
function hasSemantic(element) {
  var tag = element.tagName.toLowerCase();
  // Include structural semantic elements
  return ["h1", "h2", "h3", "h4", "h5", "h6", "nav", "main", "header",
          "footer", "section", "article", "aside", "ul", "ol", "li", "table"].includes(tag) ||
         null !== element.getAttribute("role");
}

/**
 * Decide if element should be included in tree
 */
function shouldInclude(element, options) {
  var tag = element.tagName.toLowerCase();

  // Skip non-content elements
  if (["script", "style", "meta", "link", "title", "noscript"].includes(tag))
    return false;

  // Skip aria-hidden unless filter is "all"
  if ("all" !== options.filter && "true" === element.getAttribute("aria-hidden"))
    return false;

  // Skip invisible unless filter is "all"
  if ("all" !== options.filter && !isVisible(element))
    return false;

  // Skip off-screen unless filter is "all" or we're focused on refId
  if ("all" !== options.filter && !options.refId) {
    var rect = element.getBoundingClientRect();
    if (!(rect.top < window.innerHeight && rect.bottom > 0 &&
          rect.left < window.innerWidth && rect.right > 0))
      return false;
  }

  // Include interactive elements
  if (isInteractive(element)) return true;

  // For interactive filter, also include semantic elements, images, and text
  if ("interactive" === options.filter) {
    // Include semantic elements
    if (hasSemantic(element)) return true;
    // Include images
    if (element.tagName.toLowerCase() === "img") return true;
    // Include elements with accessible names (text content)
    return getName(element).length > 0;
  }

  // For 'all' filter, include semantic elements
  if (hasSemantic(element)) return true;

  // Include elements with accessible names
  if (getName(element).length > 0) return true;

  // Include elements with non-generic roles
  var role = getRole(element);
  return null !== role && "generic" !== role && "image" !== role;
}

/**
 * Main function: Generate accessibility tree for the page
 *
 * @param {string} filter - 'interactive' or 'all' (default: 'all')
 * @param {number} maxDepth - Maximum tree depth (default: 15)
 * @param {number} maxChars - Maximum output characters (default: 50000)
 * @param {string} refId - If provided, only return subtree starting at this element
 * @returns {Object} { pageContent, viewport, error? }
 */
window.__generateAccessibilityTree = function(filter, maxDepth, maxChars, refId) {
  try {
    var output = [];
    var treeDepth = null != maxDepth ? maxDepth : 15;
    var options = { filter: filter || "all", refId: refId };

    /**
     * Recursively build tree
     */
    // eslint-disable-next-line no-inner-declarations
    function buildTree(element, depth, options) {
      if (depth > treeDepth) return;
      if (!element || !element.tagName) return;

      var include = shouldInclude(element, options) ||
                    (null !== options.refId && 0 === depth);

      if (include) {
        var role = getRole(element);
        var name = getName(element);

        // Get or create ref ID
        var ref = null;
        for (var id in window.__elementRefMap) {
          if (window.__elementRefMap[id].deref &&
              window.__elementRefMap[id].deref() === element) {
            ref = id;
            break;
          }
        }
        if (!ref) {
          ref = "ref_" + ++window.__refCounter;
          window.__elementRefMap[ref] = new WeakRef(element);
        }

        // Build line: indent + role + name + ref + attributes
        var line = " ".repeat(depth) + role;

        if (name) {
          name = name.replace(/\s+/g, " ").substring(0, 100);
          line += ' "' + name.replace(/"/g, '\\"') + '"';
        }

        line += " [" + ref + "]";

        // Add relevant attributes
        if (element.getAttribute("href"))
          line += ' href="' + element.getAttribute("href") + '"';
        if (element.getAttribute("type"))
          line += ' type="' + element.getAttribute("type") + '"';
        if (element.getAttribute("placeholder"))
          line += ' placeholder="' + element.getAttribute("placeholder") + '"';

        output.push(line);

        // Special handling for select - include options
        if ("select" === element.tagName.toLowerCase()) {
          var opts = element.options;
          for (var i = 0; i < opts.length; i++) {
            var opt = opts[i];
            var optLine = " ".repeat(depth + 1) + "option";
            var optText = opt.textContent ? opt.textContent.trim() : "";
            if (optText) {
              optText = optText.replace(/\s+/g, " ").substring(0, 100);
              optLine += ' "' + optText.replace(/"/g, '\\"') + '"';
            }
            if (opt.selected) optLine += " (selected)";
            if (opt.value && opt.value !== optText)
              optLine += ' value="' + opt.value.replace(/"/g, '\\"') + '"';
            output.push(optLine);
          }
        }
      }

      // Process children
      if (element.children && depth < treeDepth) {
        for (var j = 0; j < element.children.length; j++) {
          buildTree(element.children[j], include ? depth + 1 : depth, options);
        }
      }
    }

    /**
     * Process iframes and add their content to the tree
     */
    // eslint-disable-next-line no-inner-declarations
    function processIframes(baseDepth, frameOffsetX, frameOffsetY) {
      var iframes = document.querySelectorAll('iframe');
      for (var i = 0; i < iframes.length; i++) {
        var iframe = iframes[i];
        try {
          // Check if iframe is same-origin (we can access its content)
          var iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
          if (!iframeDoc || !iframeDoc.body) continue;

          // Get iframe position for coordinate offset
          var iframeRect = iframe.getBoundingClientRect();
          var offsetX = frameOffsetX + iframeRect.x;
          var offsetY = frameOffsetY + iframeRect.y;

          // Add iframe marker
          output.push(" ".repeat(baseDepth) + "iframe [" + (iframe.src || iframe.id || "anonymous") + "]");

          // Store iframe offset for elements inside
          var iframeOptions = Object.assign({}, options, {
            iframeOffsetX: offsetX,
            iframeOffsetY: offsetY,
            iframeDoc: iframeDoc
          });

          // Process iframe body
          buildTreeInIframe(iframeDoc.body, baseDepth + 1, iframeOptions, iframeDoc);
        } catch (e) {
          // Cross-origin iframe - can't access content
          output.push(" ".repeat(baseDepth) + "iframe (cross-origin) [" + (iframe.src || "anonymous") + "]");
        }
      }
    }

    /**
     * Build tree for elements inside an iframe
     */
    // eslint-disable-next-line no-inner-declarations
    function buildTreeInIframe(element, depth, options, doc) {
      if (depth > treeDepth) return;
      if (!element || !element.tagName) return;

      var include = shouldInclude(element, options);

      if (include) {
        var role = getRole(element);
        var name = getName(element);

        // Get or create ref ID (use special prefix for iframe elements)
        var ref = null;
        for (var id in window.__elementRefMap) {
          if (window.__elementRefMap[id].deref &&
              window.__elementRefMap[id].deref() === element) {
            ref = id;
            break;
          }
        }
        if (!ref) {
          ref = "ref_" + ++window.__refCounter;
          // Store element with iframe offset info
          window.__elementRefMap[ref] = new WeakRef(element);
          window.__elementOffsets = window.__elementOffsets || {};
          window.__elementOffsets[ref] = {
            x: options.iframeOffsetX || 0,
            y: options.iframeOffsetY || 0
          };
        }

        // Build line
        var line = " ".repeat(depth) + role;
        if (name) {
          name = name.replace(/\s+/g, " ").substring(0, 100);
          line += ' "' + name.replace(/"/g, '\\"') + '"';
        }
        line += " [" + ref + "]";

        // Add relevant attributes
        if (element.getAttribute("href"))
          line += ' href="' + element.getAttribute("href") + '"';
        if (element.getAttribute("type"))
          line += ' type="' + element.getAttribute("type") + '"';
        if (element.getAttribute("placeholder"))
          line += ' placeholder="' + element.getAttribute("placeholder") + '"';

        output.push(line);

        // Special handling for select
        if ("select" === element.tagName.toLowerCase()) {
          var opts = element.options;
          for (var i = 0; i < opts.length; i++) {
            var opt = opts[i];
            var optLine = " ".repeat(depth + 1) + "option";
            var optText = opt.textContent ? opt.textContent.trim() : "";
            if (optText) {
              optText = optText.replace(/\s+/g, " ").substring(0, 100);
              optLine += ' "' + optText.replace(/"/g, '\\"') + '"';
            }
            if (opt.selected) optLine += " (selected)";
            if (opt.value && opt.value !== optText)
              optLine += ' value="' + opt.value.replace(/"/g, '\\"') + '"';
            output.push(optLine);
          }
        }
      }

      // Process children
      if (element.children && depth < treeDepth) {
        for (var j = 0; j < element.children.length; j++) {
          buildTreeInIframe(element.children[j], include ? depth + 1 : depth, options, doc);
        }
      }
    }

    // If refId provided, start from that element
    if (refId) {
      var weakRef = window.__elementRefMap[refId];
      if (!weakRef) {
        return {
          error: "Element with ref_id '" + refId + "' not found. It may have been removed from the page. Use read_page without ref_id to get the current page state.",
          pageContent: "",
          viewport: { width: window.innerWidth, height: window.innerHeight }
        };
      }
      var el = weakRef.deref ? weakRef.deref() : null;
      if (!el) {
        return {
          error: "Element with ref_id '" + refId + "' no longer exists. It may have been removed from the page. Use read_page without ref_id to get the current page state.",
          pageContent: "",
          viewport: { width: window.innerWidth, height: window.innerHeight }
        };
      }
      buildTree(el, 0, options);
    } else {
      // Start from body
      if (document.body) buildTree(document.body, 0, options);
      // Also process iframes
      processIframes(0, 0, 0);
    }

    // Clean up dead references
    for (var id in window.__elementRefMap) {
      var ref = window.__elementRefMap[id];
      if (ref.deref && !ref.deref()) {
        delete window.__elementRefMap[id];
      }
    }

    // Check output size and truncate if needed (instead of returning empty)
    var result = output.join("\n");
    var truncated = false;
    var truncationNote = "";

    if (null != maxChars && result.length > maxChars) {
      // Find a good truncation point (end of a line)
      var truncPoint = maxChars;
      var lastNewline = result.lastIndexOf("\n", maxChars);
      if (lastNewline > maxChars * 0.8) {
        truncPoint = lastNewline;
      }
      result = result.substring(0, truncPoint);
      truncated = true;
      truncationNote = "\n\n[TRUNCATED: Output exceeded " + maxChars + " chars. " +
        "Only refs shown above are valid. Use filter='interactive' to see only interactive elements, " +
        "or use ref_id to focus on a specific element, or scroll to see more of the page.]";
    }

    return {
      pageContent: result + truncationNote,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      truncated: truncated
    };

  } catch (err) {
    throw new Error("Error generating accessibility tree: " + (err.message || "Unknown error"));
  }
};

/**
 * Get element by ref ID
 */
window.__getElementByRef = function(refId) {
  var weakRef = window.__elementRefMap[refId];
  if (weakRef && weakRef.deref) {
    var element = weakRef.deref();
    if (element && document.contains(element)) {
      return element;
    }
    // Element was garbage collected or removed
    delete window.__elementRefMap[refId];
  }
  return null;
};

/**
 * Get bounding rect for a ref ID (for coordinate-based actions)
 * Scrolls element into view first, then returns coordinates.
 * Includes iframe offset for elements inside iframes.
 */
window.__getElementRect = function(refId) {
  var element = window.__getElementByRef(refId);
  if (!element) return null;

  // Scroll element into view first
  element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });

  // Force reflow to ensure scroll is complete
  if (element instanceof HTMLElement) {
    void element.offsetHeight;
  }

  var rect = element.getBoundingClientRect();

  // Check if this element has iframe offset
  var offset = (window.__elementOffsets && window.__elementOffsets[refId]) || { x: 0, y: 0 };

  return {
    x: rect.x + offset.x,
    y: rect.y + offset.y,
    width: rect.width,
    height: rect.height,
    centerX: rect.x + rect.width / 2 + offset.x,
    centerY: rect.y + rect.height / 2 + offset.y,
  };
};

/**
 * Clear ref mappings (call when navigating to new page)
 */
window.__clearRefMappings = function() {
  window.__elementRefMap = {};
  window.__elementOffsets = {};
  window.__refCounter = 0;
};

// Expose for debugging
console.log('[Hanzi in Chrome] Accessibility tree generator loaded');
