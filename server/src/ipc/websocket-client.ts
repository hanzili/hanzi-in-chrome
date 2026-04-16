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
import type { NativeMessage, MessageHandler, ConnectionOptions } from './native-host.js';

type ClientRole = 'mcp' | 'cli';

export interface WebSocketClientOptions extends ConnectionOptions {
  /** Role to register as with the relay */
  role: ClientRole;
  /** Custom relay URL (defaults to ws://localhost:7862) */
  relayUrl?: string;
  /** Auto-start relay server if not running (default: true) */
  autoStartRelay?: boolean;
  /** Extra fields to include in the register message (e.g., relay_secret) */
  registerExtra?: Record<string, string>;
  /** Suppress all [WSClient] log output (default: false) */
  quiet?: boolean;
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
export class WebSocketClient {
  private ws: WebSocket | null = null;
  private messageHandlers: MessageHandler[] = [];
  private options: WebSocketClientOptions;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000; // Max 30 second backoff

  constructor(options: WebSocketClientOptions) {
    this.options = {
      autoStartRelay: true,
      ...options,
    };
  }

  private log(...args: any[]): void {
    if (!this.options.quiet) console.error(...args);
  }

  /**
   * Register a handler for incoming messages
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Remove a message handler
   */
  offMessage(handler: MessageHandler): void {
    const index = this.messageHandlers.indexOf(handler);
    if (index !== -1) {
      this.messageHandlers.splice(index, 1);
    }
  }

  /**
   * Connect to the relay server.
   * Auto-starts the relay if needed.
   */
  async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    const relayUrl = process.env.HANZI_RELAY_URL || this.options.relayUrl || getRelayUrl();

    // Auto-start relay if configured
    if (this.options.autoStartRelay) {
      try {
        await ensureRelayRunning(relayUrl);
      } catch (err) {
        this.log(`[WSClient] Failed to start relay: ${(err as Error).message}`);
        throw err;
      }
    }

    return new Promise((resolve, reject) => {
      try {
        this.log(`[WSClient] Connecting to relay: ${relayUrl}`);
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
          this.ws!.send(JSON.stringify({
            type: 'register',
            role: this.options.role,
            ...this.options.registerExtra,
          }));

          this.log(`[WSClient] Connected as ${this.options.role}`);
          resolve();
        });

        this.ws.on('message', (data) => {
          try {
            const message = JSON.parse(data.toString()) as NativeMessage;

            // Skip relay protocol messages
            if (message.type === 'registered') return;
            if (message.type === 'error') {
              this.log(`[WSClient] Relay error: ${message.error}`);
              return;
            }

            this.dispatchMessage(message);
          } catch (e) {
            this.log('[WSClient] Failed to parse message:', e);
          }
        });

        this.ws.on('close', () => {
          this.log('[WSClient] Disconnected from relay');
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
          this.log(`[WSClient] WebSocket error: ${err.message}`);

          if (!this.connected) {
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Dispatch a message to all registered handlers
   */
  private async dispatchMessage(message: NativeMessage): Promise<void> {
    for (const handler of this.messageHandlers) {
      try {
        await handler(message);
      } catch (err) {
        this.log('[WSClient] Handler error:', err);
      }
    }
  }

  /**
   * Send a message to the extension via relay
   */
  async send(message: NativeMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Try to reconnect
      try {
        await this.connect();
      } catch {
        throw new Error('Not connected to relay and reconnection failed');
      }
    }

    this.ws!.send(JSON.stringify(message));
  }

  /**
   * Check if connected to relay
   */
  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Disconnect from relay
   */
  disconnect(): void {
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
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    this.reconnectAttempts++;

    this.log(`[WSClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        this.log('[WSClient] Reconnected successfully');
      } catch (err) {
        this.log(`[WSClient] Reconnection failed: ${(err as Error).message}`);
        // onclose handler will schedule next attempt
      }
    }, delay);
  }
}
