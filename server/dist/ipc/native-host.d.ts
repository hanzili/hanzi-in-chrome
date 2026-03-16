/**
 * Native Host IPC Module
 *
 * Handles communication with the installed native host via Chrome native
 * messaging protocol.
 *
 * Protocol: Chrome Native Messaging (4-byte little-endian length prefix + JSON)
 *
 * This transport is no longer used for MCP task delivery. It remains for
 * native-host-backed utilities such as credential reads, debug logging, and
 * API proxy support.
 */
/** Message types sent TO the native host */
export type OutgoingMessageType = 'ping' | 'debug_log' | 'agent_log' | 'check_file' | 'read_cli_credentials' | 'read_codex_credentials' | 'proxy_api_call';
/** Message types received FROM the native host */
export type IncomingMessageType = 'pong' | 'debug_logged' | 'file_check_result' | 'cli_credentials' | 'codex_credentials' | 'credentials_not_found' | 'api_response' | 'api_error' | 'error';
/** Base message structure */
export interface NativeMessage {
    type: string;
    sessionId?: string;
    requestId?: string;
    [key: string]: any;
}
/** Callback for handling incoming messages */
export type MessageHandler = (message: NativeMessage) => void | Promise<void>;
/** Connection options */
export interface ConnectionOptions {
    /** Custom path to native host executable */
    hostPath?: string;
    /** Callback when connection is lost */
    onDisconnect?: (code: number | null) => void;
    /** Callback for native host stderr output */
    onStderr?: (data: string) => void;
}
/**
 * Manages a connection to the native host process.
 *
 * Usage:
 *   const conn = new NativeHostConnection();
 *   conn.onMessage((msg) => console.log('Received:', msg));
 *   await conn.connect();
 *   await conn.send({ type: 'ping' });
 */
export declare class NativeHostConnection {
    private process;
    private messageBuffer;
    private messageHandlers;
    private options;
    private connected;
    constructor(options?: ConnectionOptions);
    /**
     * Find the native host executable path from the installed Chrome manifest
     */
    private findHostPath;
    /**
     * Register a handler for incoming messages
     */
    onMessage(handler: MessageHandler): void;
    /**
     * Remove a message handler
     */
    offMessage(handler: MessageHandler): void;
    /**
     * Connect to the native host process
     */
    connect(): Promise<void>;
    /**
     * Process buffered messages using the native messaging protocol
     * (4-byte little-endian length prefix + JSON payload)
     */
    private processMessages;
    /**
     * Dispatch a message to all registered handlers
     */
    private dispatchMessage;
    /**
     * Send a message to the native host
     */
    send(message: NativeMessage): Promise<void>;
    /**
     * Check if connected to native host
     */
    isConnected(): boolean;
    /**
     * Disconnect from the native host
     */
    disconnect(): void;
}
/**
 * Get the default native host connection (creates one if needed)
 */
export declare function getDefaultConnection(): NativeHostConnection;
/**
 * Reset the default connection (useful for testing)
 */
export declare function resetDefaultConnection(): void;
