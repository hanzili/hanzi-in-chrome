/**
 * IPC Module - Communication with Chrome Extension
 *
 * WebSocketClient is the primary transport for MCP traffic.
 * NativeHostConnection is retained only for legacy utility flows.
 */

export { WebSocketClient, type WebSocketClientOptions } from './websocket-client.js';

export {
  NativeHostConnection,
  type NativeMessage,
  type MessageHandler,
  type ConnectionOptions,
  type OutgoingMessageType,
  type IncomingMessageType,
} from './native-host.js';
