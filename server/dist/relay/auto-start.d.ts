/**
 * Auto-start helper for the WebSocket relay server.
 *
 * Used by MCP server and CLI to ensure the relay is running
 * before attempting to connect.
 */
/**
 * Get the relay URL (configurable via WS_RELAY_PORT env var)
 */
export declare function getRelayUrl(): string;
/**
 * Check if the relay server is already running
 */
export declare function isRelayRunning(url?: string): Promise<boolean>;
/**
 * Start the relay server as a detached background process.
 * Returns once the relay is accepting connections.
 */
export declare function ensureRelayRunning(url?: string): Promise<void>;
