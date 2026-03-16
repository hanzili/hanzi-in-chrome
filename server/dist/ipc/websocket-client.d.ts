/**
 * WebSocket Client for Relay Communication
 *
 * Drop-in replacement for NativeHostConnection that communicates
 * via the WebSocket relay server instead of native messaging.
 *
 * Same interface: connect(), send(), onMessage(), isConnected(), disconnect()
 */
import type { NativeMessage, MessageHandler, ConnectionOptions } from './native-host.js';
type ClientRole = 'mcp' | 'cli';
export interface WebSocketClientOptions extends ConnectionOptions {
    /** Role to register as with the relay */
    role: ClientRole;
    /** Custom relay URL (defaults to ws://localhost:7862) */
    relayUrl?: string;
    /** Auto-start relay server if not running (default: true) */
    autoStartRelay?: boolean;
}
/**
 * WebSocket-based connection to the Chrome extension via relay server.
 *
 * Usage:
 *   const client = new WebSocketClient({ role: 'mcp' });
 *   client.onMessage((msg) => console.log('Received:', msg));
 *   await client.connect();
 *   await client.send({ type: 'mcp_start_task', sessionId: 'abc', task: '...' });
 */
export declare class WebSocketClient {
    private ws;
    private messageHandlers;
    private options;
    private connected;
    private reconnectTimer;
    private reconnectAttempts;
    private maxReconnectDelay;
    constructor(options: WebSocketClientOptions);
    /**
     * Register a handler for incoming messages
     */
    onMessage(handler: MessageHandler): void;
    /**
     * Remove a message handler
     */
    offMessage(handler: MessageHandler): void;
    /**
     * Connect to the relay server.
     * Auto-starts the relay if needed.
     */
    connect(): Promise<void>;
    /**
     * Dispatch a message to all registered handlers
     */
    private dispatchMessage;
    /**
     * Send a message to the extension via relay
     */
    send(message: NativeMessage): Promise<void>;
    /**
     * Check if connected to relay
     */
    isConnected(): boolean;
    /**
     * Disconnect from relay
     */
    disconnect(): void;
    /**
     * Schedule a reconnection attempt with exponential backoff
     */
    private scheduleReconnect;
}
export {};
