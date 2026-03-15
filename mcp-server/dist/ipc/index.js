/**
 * IPC Module - Communication with Chrome Extension
 *
 * WebSocketClient is the primary transport for MCP traffic.
 * NativeHostConnection is retained only for legacy utility flows.
 */
export { WebSocketClient } from './websocket-client.js';
export { NativeHostConnection, } from './native-host.js';
