/**
 * Sets up a global HTTP proxy for Node.js fetch().
 * Load with: node --import ./proxy-setup.mjs dist/managed/deploy.js
 *
 * Reads from PROXY_URL env var, or falls back to http_proxy/https_proxy.
 * Only activates if a proxy URL is found.
 */
import { ProxyAgent, setGlobalDispatcher } from 'undici';

const proxyUrl = process.env.PROXY_URL || process.env.http_proxy || process.env.https_proxy;

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.error(`[Proxy] Global fetch proxy set to ${proxyUrl}`);
} else {
  console.error('[Proxy] No proxy configured (set PROXY_URL, http_proxy, or https_proxy)');
}
