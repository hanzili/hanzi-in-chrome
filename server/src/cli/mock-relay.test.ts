import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockRelay } from './mock-relay.js';
import WebSocket from 'ws';

describe('MockRelay', () => {
  let relay: MockRelay;

  beforeEach(async () => { relay = await MockRelay.start(); });
  afterEach(async () => { await relay.stop(); });

  it('accepts a CLI connection and records sent messages', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/?role=cli`);
    await new Promise(res => ws.once('open', res));
    ws.send(JSON.stringify({ type: 'mcp_start_task', sessionId: 's1', task: 'hi' }));
    await new Promise(res => setTimeout(res, 50));
    expect(relay.received).toHaveLength(1);
    expect(relay.received[0].type).toBe('mcp_start_task');
    ws.close();
  });

  it('broadcasts a scripted response to the connected CLI', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/?role=cli`);
    const received: any[] = [];
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString())));
    await new Promise(res => ws.once('open', res));
    relay.emit({ type: 'task_complete', sessionId: 's1', result: 'done' });
    await new Promise(res => setTimeout(res, 50));
    expect(received).toHaveLength(1);
    expect(received[0].result).toBe('done');
    ws.close();
  });
});
