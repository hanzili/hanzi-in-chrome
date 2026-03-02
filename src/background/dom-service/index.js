/**
 * DOM Service
 *
 * Extracts and processes page DOM using Chrome DevTools Protocol.
 * Makes 4 parallel CDP calls, merges results into enhanced tree,
 * then serializes to compact text format for LLM consumption.
 *
 * Architecture mirrors browser-use's DomService but runs in a
 * Chrome extension service worker using chrome.debugger API.
 *
 * Usage (from service worker):
 *   import { extractDomState } from './dom-service/index.js';
 *   const { text, selectorMap, timing } = await extractDomState(tabId);
 *
 * Usage (offline with raw CDP JSON — for testing):
 *   import { processCdpData } from './dom-service/index.js';
 *   const { text, selectorMap } = processCdpData(rawCdpJson);
 */

import { buildSnapshotLookup, REQUIRED_COMPUTED_STYLES } from './snapshot-lookup.js';
import { buildAxLookup, buildEnhancedTree } from './tree-builder.js';
import { serializeDomTree } from './serializer.js';

/**
 * Process raw CDP data into serialized DOM state.
 * Used for offline testing (with golden reference data) and
 * as the core processing step in live extraction.
 *
 * @param {Object} rawCdp - Object with keys: dom_snapshot, dom_tree, ax_tree, layout_metrics
 * @param {Object} [options]
 * @param {number} [options.maxChars=40000]
 * @returns {{ text: string, selectorMap: Map<number, Object>, stats: Object }}
 */
export function processCdpData(rawCdp, options = {}) {
  const { dom_snapshot, dom_tree, ax_tree, layout_metrics } = rawCdp;

  // Calculate device pixel ratio
  const cssViewport = layout_metrics?.cssVisualViewport || {};
  const visualViewport = layout_metrics?.visualViewport || {};
  const viewportWidth = cssViewport.clientWidth || 1200;
  const viewportHeight = cssViewport.clientHeight || 725;

  let devicePixelRatio = 1.0;
  if (visualViewport.clientWidth && cssViewport.clientWidth) {
    devicePixelRatio = visualViewport.clientWidth / cssViewport.clientWidth;
  }

  // Phase 1: Build snapshot lookup
  const snapshotLookup = buildSnapshotLookup(dom_snapshot, devicePixelRatio);

  // Phase 2: Build AX lookup
  const axLookup = buildAxLookup(ax_tree.nodes);

  // Phase 3: Build enhanced tree
  const enhancedRoot = buildEnhancedTree(
    dom_tree.root,
    axLookup,
    snapshotLookup,
    viewportHeight,
  );

  // Phase 4: Serialize
  const { text, selectorMap, truncated } = serializeDomTree(enhancedRoot, options);

  return {
    text,
    selectorMap,
    stats: {
      devicePixelRatio,
      viewportWidth,
      viewportHeight,
      snapshotNodes: snapshotLookup.size,
      axNodes: axLookup.size,
      interactiveElements: selectorMap.size,
      textLength: text.length,
      truncated,
    },
  };
}

/**
 * Extract DOM state from a live Chrome tab using CDP.
 * Requires chrome.debugger to be attached to the tab.
 *
 * @param {number} tabId - Chrome tab ID
 * @param {(tabId: number, method: string, params?: Object) => Promise<*>} sendCommand - CDP command sender (e.g., sendDebuggerCommand from debugger-manager)
 * @param {Object} [options]
 * @param {number} [options.maxChars=40000]
 * @param {boolean} [options.includeScreenshot=false]
 * @returns {Promise<{ text: string, selectorMap: Map<number, Object>, screenshot?: string, stats: Object }>}
 */
export async function extractDomState(tabId, sendCommand, options = {}) {
  const { maxChars = 40000, includeScreenshot = false } = options;

  const cdp = (method, params = {}) => sendCommand(tabId, method, params);

  const startTime = performance.now();

  // Enable required domains
  await Promise.all([
    cdp('DOM.enable'),
    cdp('DOMSnapshot.enable'),
    cdp('Accessibility.enable'),
    cdp('Page.enable'),
  ]);

  // Get frame tree (needed for per-frame AX tree)
  const frameTreeResult = await cdp('Page.getFrameTree');
  const frameIds = [];
  function collectFrames(ft) {
    frameIds.push(ft.frame.id);
    for (const child of ft.childFrames || []) {
      collectFrames(child);
    }
  }
  collectFrames(frameTreeResult.frameTree);

  // Make 4 CDP calls in parallel
  const [snapshotResult, domResult, layoutResult, ...axResults] = await Promise.all([
    // 1. DOMSnapshot
    cdp('DOMSnapshot.captureSnapshot', {
      computedStyles: REQUIRED_COMPUTED_STYLES,
      includePaintOrder: true,
      includeDOMRects: true,
      includeBlendedBackgroundColors: false,
      includeTextColorOpacities: false,
    }),
    // 2. DOM tree with shadow piercing
    cdp('DOM.getDocument', { depth: -1, pierce: true }),
    // 3. Layout metrics
    cdp('Page.getLayoutMetrics'),
    // 4. AX tree per frame
    ...frameIds.map(fid =>
      cdp('Accessibility.getFullAXTree', { frameId: fid }).catch(() => ({ nodes: [] }))
    ),
  ]);

  // Merge AX nodes from all frames
  const allAxNodes = [];
  for (const axResult of axResults) {
    if (axResult?.nodes) allAxNodes.push(...axResult.nodes);
  }

  const cdpTime = performance.now() - startTime;

  // Process the raw CDP data
  const rawCdp = {
    dom_snapshot: snapshotResult,
    dom_tree: domResult,
    ax_tree: { nodes: allAxNodes },
    layout_metrics: layoutResult,
  };

  const result = processCdpData(rawCdp, { maxChars });

  // Optionally take screenshot (using captureVisibleTab to avoid CDP hang)
  let screenshot = null;
  if (includeScreenshot) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 75 });
      screenshot = dataUrl?.split(',')[1] || null;
    } catch (_) { /* ignore screenshot errors */ }
  }

  return {
    ...result,
    screenshot,
    stats: {
      ...result.stats,
      cdpTimeMs: Math.round(cdpTime),
      totalTimeMs: Math.round(performance.now() - startTime),
      frameCount: frameIds.length,
    },
  };
}
