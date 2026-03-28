/**
 * Lightweight Sentry error reporter for Chrome extension service worker.
 * No SDK dependency — sends errors directly to Sentry's envelope API.
 *
 * This avoids bundling @sentry/browser which requires DOM APIs
 * that don't exist in Manifest V3 service workers.
 */

const SENTRY_DSN = 'https://2d5504c5db572b0b2709e64f03bdfcc6@o4511120870932480.ingest.us.sentry.io/4511120907698176';
const EXTENSION_VERSION = chrome.runtime.getManifest().version;

let dsn = null;
try {
  const url = new URL(SENTRY_DSN);
  dsn = {
    publicKey: url.username,
    host: url.hostname,
    projectId: url.pathname.replace('/', ''),
    ingestUrl: `https://${url.hostname}/api${url.pathname}/envelope/`,
  };
} catch {}

function createEnvelope(event) {
  const header = JSON.stringify({
    event_id: crypto.randomUUID().replace(/-/g, ''),
    dsn: SENTRY_DSN,
    sdk: { name: 'hanzi-extension', version: EXTENSION_VERSION },
  });
  const itemHeader = JSON.stringify({ type: 'event', length: JSON.stringify(event).length });
  return `${header}\n${itemHeader}\n${JSON.stringify(event)}`;
}

export function captureError(error, context = {}) {
  if (!dsn) return;

  const event = {
    level: 'error',
    platform: 'javascript',
    release: `hanzi-browse-extension@${EXTENSION_VERSION}`,
    environment: 'production',
    exception: {
      values: [{
        type: error.name || 'Error',
        value: error.message,
        stacktrace: error.stack ? {
          frames: error.stack.split('\n').slice(1).map(line => {
            const match = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/) ||
                          line.match(/at\s+(.+?):(\d+):(\d+)/);
            if (!match) return { filename: '<unknown>', function: line.trim() };
            if (match.length === 5) {
              return { function: match[1], filename: match[2], lineno: parseInt(match[3]), colno: parseInt(match[4]) };
            }
            return { filename: match[1], lineno: parseInt(match[2]), colno: parseInt(match[3]) };
          }).reverse(),
        } : undefined,
      }],
    },
    tags: {
      runtime: 'service-worker',
      ...context,
    },
    contexts: {
      browser: { name: 'Chrome' },
    },
  };

  // Fire and forget — don't let reporting errors break the extension
  fetch(dsn.ingestUrl, {
    method: 'POST',
    body: createEnvelope(event),
  }).catch(() => {});
}

export function initErrorReporting() {
  if (!dsn) return;

  // Catch unhandled errors in the service worker
  self.addEventListener('error', (event) => {
    captureError(event.error || new Error(event.message), { source: 'unhandled' });
  });

  self.addEventListener('unhandledrejection', (event) => {
    const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    captureError(error, { source: 'unhandled_promise' });
  });
}
