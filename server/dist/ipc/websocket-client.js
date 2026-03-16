/**
 * WebSocket Client for Relay Communication
 *
 * Drop-in replacement for NativeHostConnection that communicates
 * via the WebSocket relay server instead of native messaging.
 *
 * Same interface: connect(), send(), onMessage(), isConnected(), disconnect()
 */
import WebSocket from 'ws';
import { ensureRelayRunning, getRelayUrl } from '../relay/auto-start.js';
/**
 * WebSocket-based connection to the Chrome extension via relay server.
 *
 * Usage:
 *   const client = new WebSocketClient({ role: 'mcp' });
 *   client.onMessage((msg) => console.log('Received:', msg));
 *   await client.connect();
 *   await client.send({ type: 'mcp_start_task', sessionId: 'abc', task: '...' });
 */
export class WebSocketClient {
    ws = null;
    messageHandlers = [];
    options;
    connected = false;
    reconnectTimer = null;
    reconnectAttempts = 0;
    maxReconnectDelay = 30000; // Max 30 second backoff
    constructor(options) {
        this.options = {
            autoStartRelay: true,
            ...options,
        };
    }
    /**
     * Register a handler for incoming messages
     */
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }
    /**
     * Remove a message handler
     */
    offMessage(handler) {
        const index = this.messageHandlers.indexOf(handler);
        if (index !== -1) {
            this.messageHandlers.splice(index, 1);
        }
    }
    /**
     * Connect to the relay server.
     * Auto-starts the relay if needed.
     */
    async connect() {
        if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
            return; // Already connected
        }
        const relayUrl = this.options.relayUrl || getRelayUrl();
        // Auto-start relay if configured
        if (this.options.autoStartRelay) {
            try {
                await ensureRelayRunning(relayUrl);
            }
            catch (err) {
                console.error(`[WSClient] Failed to start relay: ${err.message}`);
                throw err;
            }
        }
        return new Promise((resolve, reject) => {
            try {
                console.error(`[WSClient] Connecting to relay: ${relayUrl}`);
                this.ws = new WebSocket(relayUrl);
                const connectTimeout = setTimeout(() => {
                    if (!this.connected) {
                        this.ws?.terminate();
                        reject(new Error('WebSocket connection timed out'));
                    }
                }, 5000);
                this.ws.on('open', () => {
                    clearTimeout(connectTimeout);
                    this.connected = true;
                    this.reconnectAttempts = 0;
                    // Register with relay
                    this.ws.send(JSON.stringify({
                        type: 'register',
                        role: this.options.role,
                    }));
                    console.error(`[WSClient] Connected as ${this.options.role}`);
                    resolve();
                });
                this.ws.on('message', (data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        // Skip relay protocol messages
                        if (message.type === 'registered')
                            return;
                        if (message.type === 'error') {
                            console.error(`[WSClient] Relay error: ${message.error}`);
                            return;
                        }
                        this.dispatchMessage(message);
                    }
                    catch (e) {
                        console.error('[WSClient] Failed to parse message:', e);
                    }
                });
                this.ws.on('close', () => {
                    console.error('[WSClient] Disconnected from relay');
                    this.connected = false;
                    this.ws = null;
                    if (this.options.onDisconnect) {
                        this.options.onDisconnect(null);
                    }
                    // Schedule reconnect with exponential backoff
                    this.scheduleReconnect();
                });
                this.ws.on('error', (err) => {
                    clearTimeout(connectTimeout);
                    console.error(`[WSClient] WebSocket error: ${err.message}`);
                    if (!this.connected) {
                        reject(err);
                    }
                });
            }
            catch (err) {
                reject(err);
            }
        });
    }
    /**
     * Dispatch a message to all registered handlers
     */
    async dispatchMessage(message) {
        for (const handler of this.messageHandlers) {
            try {
                await handler(message);
            }
            catch (err) {
                console.error('[WSClient] Handler error:', err);
            }
        }
    }
    /**
     * Send a message to the extension via relay
     */
    async send(message) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            // Try to reconnect
            try {
                await this.connect();
            }
            catch {
                throw new Error('Not connected to relay and reconnection failed');
            }
        }
        this.ws.send(JSON.stringify(message));
    }
    /**
     * Check if connected to relay
     */
    isConnected() {
        return this.connected && this.ws?.readyState === WebSocket.OPEN;
    }
    /**
     * Disconnect from relay
     */
    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }
    /**
     * Schedule a reconnection attempt with exponential backoff
     */
    scheduleReconnect() {
        if (this.reconnectTimer)
            return;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
        this.reconnectAttempts++;
        console.error(`[WSClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
                console.error('[WSClient] Reconnected successfully');
            }
            catch (err) {
                console.error(`[WSClient] Reconnection failed: ${err.message}`);
                // onclose handler will schedule next attempt
            }
        }, delay);
    }
}
