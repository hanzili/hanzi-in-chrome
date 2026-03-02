/**
 * Enhanced DOM Tree Builder
 *
 * Merges three CDP data sources into a single enhanced tree:
 * 1. DOM.getDocument (structure, attributes, shadow DOM)
 * 2. Accessibility.getFullAXTree (roles, names, descriptions)
 * 3. DOMSnapshot.captureSnapshot (bounds, visibility, computed styles)
 *
 * Port of browser-use's service.py:_construct_enhanced_node()
 */

/**
 * @typedef {Object} EnhancedNode
 * @property {number} nodeId
 * @property {number} backendNodeId
 * @property {number} nodeType - 1=Element, 3=Text, 11=DocumentFragment
 * @property {string} nodeName
 * @property {string} nodeValue
 * @property {Object<string,string>} attributes
 * @property {string|null} frameId
 * @property {string|null} shadowRootType - 'open' or 'closed'
 * @property {Object|null} axNode - {role, name, description, properties}
 * @property {import('./snapshot-lookup.js').SnapshotNode|null} snapshotNode
 * @property {boolean|null} isVisible
 * @property {{x:number,y:number,width:number,height:number}|null} absolutePosition
 * @property {EnhancedNode|null} contentDocument
 * @property {EnhancedNode[]|null} shadowRoots
 * @property {EnhancedNode[]|null} children
 */

/**
 * Build AX tree lookup: backendDOMNodeId → AX node data
 *
 * @param {Array} axNodes - Raw AX nodes from Accessibility.getFullAXTree
 * @returns {Map<number, Object>}
 */
export function buildAxLookup(axNodes) {
  const lookup = new Map();
  for (const node of axNodes) {
    if (node.backendDOMNodeId != null) {
      lookup.set(node.backendDOMNodeId, node);
    }
  }
  return lookup;
}

/**
 * Convert raw AX node to simplified format
 */
function buildEnhancedAxNode(raw) {
  if (!raw) return null;

  const role = raw.role?.value || null;
  const name = raw.name?.value || null;
  const description = raw.description?.value || null;

  const properties = {};
  if (raw.properties) {
    for (const prop of raw.properties) {
      properties[prop.name] = prop.value?.value ?? null;
    }
  }

  return { role, name, description, properties, ignored: raw.ignored || false };
}

/**
 * Check if a node is visible based on snapshot data and position.
 * Simplified version of browser-use's is_element_visible_according_to_all_parents.
 */
/**
 * @param {number} viewportThreshold - Extra pixels beyond viewport to consider visible.
 *   browser-use default is 1000px. Set to Infinity to disable.
 */
function isNodeVisible(snapshotNode, absolutePosition, viewportHeight, viewportThreshold = 10000) {
  if (!snapshotNode) return false;

  const styles = snapshotNode.computedStyles;
  if (styles) {
    if (styles.display === 'none') return false;
    if (styles.visibility === 'hidden') return false;
    try {
      if (parseFloat(styles.opacity) === 0) return false;
    } catch (_) { /* ignore */ }
  }

  if (!absolutePosition) return false;
  if (absolutePosition.width <= 0 || absolutePosition.height <= 0) return false;

  // Within viewport + threshold (browser-use default: viewport + 1000px)
  if (absolutePosition.y > viewportHeight + viewportThreshold) return false;

  return true;
}

/**
 * Build enhanced DOM tree by merging DOM, AX, and snapshot data.
 *
 * @param {Object} domRoot - Root node from DOM.getDocument response
 * @param {Map<number, Object>} axLookup - backendDOMNodeId → AX node
 * @param {Map<number, import('./snapshot-lookup.js').SnapshotNode>} snapshotLookup - backendNodeId → snapshot data
 * @param {number} viewportHeight - Viewport height for visibility filtering
 * @returns {EnhancedNode}
 */
export function buildEnhancedTree(domRoot, axLookup, snapshotLookup, viewportHeight = 725) {
  const nodeCache = new Map();

  function construct(node, frameOffset) {
    if (!node) return null;

    const nodeId = node.nodeId || 0;

    // Memoize
    if (nodeCache.has(nodeId) && nodeId !== 0) {
      return nodeCache.get(nodeId);
    }

    const backendNodeId = node.backendNodeId || 0;
    const nodeType = node.nodeType || 1;
    const nodeName = node.nodeName || '';
    const nodeValue = node.nodeValue || '';

    // Parse flat attribute array [key, val, key, val, ...]
    const attributes = {};
    const rawAttrs = node.attributes || [];
    for (let i = 0; i < rawAttrs.length; i += 2) {
      if (i + 1 < rawAttrs.length) {
        attributes[rawAttrs[i]] = rawAttrs[i + 1];
      }
    }

    // Look up AX node
    const axRaw = axLookup.get(backendNodeId);
    const axNode = buildEnhancedAxNode(axRaw);

    // Look up snapshot data
    const snapshotNode = snapshotLookup.get(backendNodeId) || null;

    // Calculate absolute position
    let absolutePosition = null;
    if (snapshotNode && snapshotNode.bounds) {
      absolutePosition = {
        x: snapshotNode.bounds.x + frameOffset.x,
        y: snapshotNode.bounds.y + frameOffset.y,
        width: snapshotNode.bounds.width,
        height: snapshotNode.bounds.height,
      };
    }

    // Calculate child frame offset for iframes
    let childFrameOffset = frameOffset;
    if (nodeName === 'IFRAME' && absolutePosition) {
      childFrameOffset = {
        x: absolutePosition.x,
        y: absolutePosition.y,
      };
    }

    // Process content document (iframes)
    let contentDocument = null;
    if (node.contentDocument) {
      contentDocument = construct(node.contentDocument, childFrameOffset);
    }

    // Process shadow roots
    let shadowRoots = null;
    if (node.shadowRoots && node.shadowRoots.length > 0) {
      shadowRoots = [];
      for (const sr of node.shadowRoots) {
        const srNode = construct(sr, childFrameOffset);
        if (srNode) shadowRoots.push(srNode);
      }
    }

    // Process children
    let children = null;
    if (node.children && node.children.length > 0) {
      children = [];
      for (const child of node.children) {
        const childNode = construct(child, childFrameOffset);
        if (childNode) children.push(childNode);
      }
    }

    // Create enhanced node
    const enhanced = {
      nodeId,
      backendNodeId,
      nodeType,
      nodeName,
      nodeValue,
      attributes,
      frameId: node.frameId || null,
      shadowRootType: node.shadowRootType || null,
      axNode,
      snapshotNode,
      absolutePosition,
      isVisible: isNodeVisible(snapshotNode, absolutePosition, viewportHeight),
      contentDocument,
      shadowRoots,
      children,
    };

    if (nodeId !== 0) {
      nodeCache.set(nodeId, enhanced);
    }

    return enhanced;
  }

  return construct(domRoot, { x: 0, y: 0 });
}
