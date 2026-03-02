/**
 * Read page tool handler
 * Extracts DOM state via Chrome DevTools Protocol (CDP).
 *
 * Uses browser-use's 3-way merge approach:
 *   DOM.getDocument + Accessibility.getFullAXTree + DOMSnapshot.captureSnapshot
 * to produce a rich, serialized DOM tree with [backendNodeId] references.
 */

import { extractDomState } from '../dom-service/index.js';
import { ensureDebugger, sendDebuggerCommand } from '../managers/debugger-manager.js';

/**
 * Handle read_page tool - get serialized DOM representation via CDP
 *
 * @param {Object} input - Tool input
 * @param {number} input.tabId - Tab ID to read from
 * @param {number} [input.max_chars] - Max output chars (default: 50000)
 * @returns {Promise<{output?: string, error?: string}>}
 */
export async function handleReadPage(input) {
  const { tabId, max_chars } = input || {};

  if (!tabId) {
    throw new Error('No active tab found');
  }

  const tab = await chrome.tabs.get(tabId);
  if (!tab.id) {
    throw new Error('Active tab has no ID');
  }

  try {
    // Ensure debugger is attached
    const attached = await ensureDebugger(tabId);
    if (!attached) {
      return { error: 'Failed to attach debugger to tab. The tab may have been closed or navigated.' };
    }

    // Extract DOM state via CDP
    const result = await extractDomState(tabId, sendDebuggerCommand, {
      maxChars: max_chars ?? 50000,
    });

    if (!result.text) {
      return { error: 'Page returned empty DOM tree. The page may still be loading.' };
    }

    const stats = result.stats;
    const meta = [
      `URL: ${tab.url}`,
      `Viewport: ${stats.viewportWidth}x${stats.viewportHeight}`,
      `Interactive elements: ${stats.interactiveElements}`,
    ];
    if (stats.truncated) {
      meta.push('(output truncated — use max_chars to increase limit)');
    }

    return {
      output: `${result.text}\n\n${meta.join(' | ')}`,
    };
  } catch (err) {
    return {
      error: `Failed to read page: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}
