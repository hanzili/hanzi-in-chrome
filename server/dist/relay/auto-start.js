/**
 * Auto-start helper for the WebSocket relay server.
 *
 * Used by MCP server and CLI to ensure the relay is running
 * before attempting to connect.
 */
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
const DEFAULT_PORT = 7862;
/**
 * Get the relay URL (configurable via WS_RELAY_PORT env var)
 */
export function getRelayUrl() {
    const port = process.env.WS_RELAY_PORT || String(DEFAULT_PORT);
    return `ws://localhost:${port}`;
}
/**
 * Check if the relay server is already running
 */
export async function isRelayRunning(url) {
    const relayUrl = url || getRelayUrl();
    return new Promise((resolve) => {
        const ws = new WebSocket(relayUrl);
        const timeout = setTimeout(() => {
            ws.terminate();
            resolve(false);
        }, 1000);
        ws.on('open', () => {
            clearTimeout(timeout);
            ws.close();
            resolve(true);
        });
        ws.on('error', () => {
            clearTimeout(timeout);
            resolve(false);
        });
    });
}
/**
 * Start the relay server as a detached background process.
 * Returns once the relay is accepting connections.
 */
export async function ensureRelayRunning(url) {
    const relayUrl = url || getRelayUrl();
    // Already running?
    if (await isRelayRunning(relayUrl)) {
        return;
    }
    // Find the relay server script (compiled JS)
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const relayScript = join(__dirname, 'server.js');
    console.error(`[Relay] Starting relay server: ${relayScript}`);
    // Spawn as detached process that outlives the parent
    const child = spawn(process.execPath, [relayScript], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
    });
    child.unref();
    // Wait for it to be ready (up to 3 seconds)
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (await isRelayRunning(relayUrl)) {
            console.error('[Relay] Server is ready');
            return;
        }
    }
    throw new Error('Relay server failed to start within 3 seconds');
}
