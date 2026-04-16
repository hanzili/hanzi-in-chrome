import { WebSocketServer, type WebSocket } from 'ws';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';

export class MockRelay {
  private httpServer: Server;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  public received: any[] = [];
  public port = 0;

  private constructor() {
    this.httpServer = createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('message', (raw) => {
        try { this.received.push(JSON.parse(raw.toString())); } catch {}
      });
      ws.on('close', () => this.clients.delete(ws));
    });
  }

  static async start(): Promise<MockRelay> {
    const relay = new MockRelay();
    await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', resolve));
    relay.port = (relay.httpServer.address() as AddressInfo).port;
    return relay;
  }

  emit(message: any): void {
    const payload = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }
}
