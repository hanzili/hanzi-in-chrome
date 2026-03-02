/**
 * IPC Module - Communication with Chrome Extension
 *
 * WebSocketClient is the primary transport (via WebSocket relay).
 */
export { WebSocketClient, type WebSocketClientOptions } from './websocket-client.js';
export { NativeHostConnection, type NativeMessage, type MessageHandler, type ConnectionOptions, type OutgoingMessageType, type IncomingMessageType, } from './native-host.js';
