/**
 * Snapshot Lookup Builder
 *
 * Processes DOMSnapshot.captureSnapshot CDP response into a lookup table
 * keyed by backendNodeId. Each entry contains bounding box, computed styles,
 * clickability, paint order, and scroll info.
 *
 * Port of browser-use's enhanced_snapshot.py:build_snapshot_lookup()
 */

/**
 * @typedef {Object} SnapshotNode
 * @property {boolean|null} isClickable
 * @property {string|null} cursorStyle
 * @property {{x:number, y:number, width:number, height:number}|null} bounds
 * @property {{x:number, y:number, width:number, height:number}|null} clientRects
 * @property {{x:number, y:number, width:number, height:number}|null} scrollRects
 * @property {Object<string,string>|null} computedStyles
 * @property {number|null} paintOrder
 */

// Same styles browser-use requests from DOMSnapshot.captureSnapshot
export const REQUIRED_COMPUTED_STYLES = [
  'display',
  'visibility',
  'opacity',
  'overflow',
  'overflow-x',
  'overflow-y',
  'cursor',
  'pointer-events',
  'position',
  'background-color',
];

/**
 * Check if a snapshot index is in RareBooleanData.
 * RareBooleanData = { index: number[] } — indices where the boolean is true.
 */
function parseRareBoolean(rareData, index) {
  if (!rareData || !rareData.index) return null;
  return rareData.index.includes(index);
}

/**
 * Parse computed styles from layout tree using string indices.
 * style_indices is an array of indices into the strings array.
 * Each index maps positionally to REQUIRED_COMPUTED_STYLES.
 */
function parseComputedStyles(strings, styleIndices) {
  const styles = {};
  for (let i = 0; i < styleIndices.length && i < REQUIRED_COMPUTED_STYLES.length; i++) {
    const strIdx = styleIndices[i];
    if (strIdx >= 0 && strIdx < strings.length) {
      styles[REQUIRED_COMPUTED_STYLES[i]] = strings[strIdx];
    }
  }
  return styles;
}

/**
 * Build snapshot lookup from DOMSnapshot.captureSnapshot response.
 *
 * @param {Object} snapshot - Raw CDP DOMSnapshot.captureSnapshot response
 * @param {number} devicePixelRatio - Device pixel ratio for coordinate conversion
 * @returns {Map<number, SnapshotNode>} backendNodeId → SnapshotNode
 */
export function buildSnapshotLookup(snapshot, devicePixelRatio = 1.0) {
  const lookup = new Map();

  if (!snapshot.documents || snapshot.documents.length === 0) {
    return lookup;
  }

  const strings = snapshot.strings;

  for (const document of snapshot.documents) {
    const nodes = document.nodes;
    const layout = document.layout;

    // Build backendNodeId → snapshot array index lookup
    const backendToIndex = new Map();
    if (nodes.backendNodeId) {
      for (let i = 0; i < nodes.backendNodeId.length; i++) {
        backendToIndex.set(nodes.backendNodeId[i], i);
      }
    }

    // Pre-build layout index map (first occurrence only, matching Python behavior)
    const layoutIndexMap = new Map();
    if (layout && layout.nodeIndex) {
      for (let layoutIdx = 0; layoutIdx < layout.nodeIndex.length; layoutIdx++) {
        const nodeIndex = layout.nodeIndex[layoutIdx];
        if (!layoutIndexMap.has(nodeIndex)) {
          layoutIndexMap.set(nodeIndex, layoutIdx);
        }
      }
    }

    // Build snapshot data for each backend node
    for (const [backendNodeId, snapshotIndex] of backendToIndex) {
      let isClickable = null;
      if (nodes.isClickable) {
        isClickable = parseRareBoolean(nodes.isClickable, snapshotIndex);
      }

      let cursorStyle = null;
      let bounds = null;
      let computedStyles = null;
      let paintOrder = null;
      let clientRects = null;
      let scrollRects = null;

      if (layoutIndexMap.has(snapshotIndex)) {
        const layoutIdx = layoutIndexMap.get(snapshotIndex);

        // Parse bounding box (convert device pixels → CSS pixels)
        if (layout.bounds && layoutIdx < layout.bounds.length) {
          const b = layout.bounds[layoutIdx];
          if (b && b.length >= 4) {
            bounds = {
              x: b[0] / devicePixelRatio,
              y: b[1] / devicePixelRatio,
              width: b[2] / devicePixelRatio,
              height: b[3] / devicePixelRatio,
            };
          }
        }

        // Parse computed styles
        if (layout.styles && layoutIdx < layout.styles.length) {
          computedStyles = parseComputedStyles(strings, layout.styles[layoutIdx]);
          cursorStyle = computedStyles.cursor || null;
        }

        // Paint order
        if (layout.paintOrders && layoutIdx < layout.paintOrders.length) {
          paintOrder = layout.paintOrders[layoutIdx];
        }

        // Client rects
        if (layout.clientRects && layoutIdx < layout.clientRects.length) {
          const cr = layout.clientRects[layoutIdx];
          if (cr && cr.length >= 4) {
            clientRects = { x: cr[0], y: cr[1], width: cr[2], height: cr[3] };
          }
        }

        // Scroll rects
        if (layout.scrollRects && layoutIdx < layout.scrollRects.length) {
          const sr = layout.scrollRects[layoutIdx];
          if (sr && sr.length >= 4) {
            scrollRects = { x: sr[0], y: sr[1], width: sr[2], height: sr[3] };
          }
        }
      }

      lookup.set(backendNodeId, {
        isClickable,
        cursorStyle,
        bounds,
        clientRects,
        scrollRects,
        computedStyles: computedStyles && Object.keys(computedStyles).length > 0 ? computedStyles : null,
        paintOrder,
      });
    }
  }

  return lookup;
}
