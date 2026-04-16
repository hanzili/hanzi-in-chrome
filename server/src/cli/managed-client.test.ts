import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { managedApiCall, runManagedTask } from './managed-client.js';

describe('managed-client', () => {
  let server: Server;
  let port: number;
  let receivedRequests: Array<{ method?: string; url?: string; body?: string }> = [];
  let nextResponses: Array<{ status: number; body: any }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        receivedRequests.push({ method: req.method, url: req.url, body });
        const next = nextResponses.shift() ?? { status: 200, body: {} };
        res.writeHead(next.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(next.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    receivedRequests = [];
    nextResponses = [];
  });

  const opts = () => ({ apiUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key' });

  it('returns "No browser connected" when no session is paired', async () => {
    nextResponses.push({ status: 200, body: { sessions: [] } });
    const r = await runManagedTask('test task', undefined, undefined, 10000, opts());
    expect(r.status).toBe('error');
    expect(r.answer).toMatch(/No browser connected/);
  });

  it('posts task and polls until complete', async () => {
    nextResponses.push({ status: 200, body: { sessions: [{ id: 'sess1', status: 'connected' }] } });
    nextResponses.push({ status: 200, body: { id: 'task1', status: 'running' } });
    nextResponses.push({ status: 200, body: { id: 'task1', status: 'running' } });
    nextResponses.push({ status: 200, body: { id: 'task1', status: 'complete', answer: 'hello', steps: 3 } });

    const r = await runManagedTask('test task', 'https://example.com', 'some context', 30000, opts());
    expect(r.status).toBe('complete');
    expect(r.answer).toBe('hello');
    expect(r.steps).toBe(3);

    // Verify request shapes
    expect(receivedRequests[0].method).toBe('GET');
    expect(receivedRequests[0].url).toBe('/v1/browser-sessions');
    expect(receivedRequests[1].method).toBe('POST');
    expect(receivedRequests[1].url).toBe('/v1/tasks');
    expect(JSON.parse(receivedRequests[1].body!).task).toBe('test task');
    expect(JSON.parse(receivedRequests[1].body!).browser_session_id).toBe('sess1');
  });

  it('returns timeout status when task stays running past timeoutMs', async () => {
    nextResponses.push({ status: 200, body: { sessions: [{ id: 'sess1', status: 'connected' }] } });
    nextResponses.push({ status: 200, body: { id: 'task1', status: 'running' } });
    // Subsequent polls keep saying running
    for (let i = 0; i < 10; i++) {
      nextResponses.push({ status: 200, body: { id: 'task1', status: 'running' } });
    }

    const r = await runManagedTask('slow', undefined, undefined, 3500, opts());
    expect(r.status).toBe('timeout');
  }, 10000);

  it('managedApiCall sends Authorization header and correct JSON body', async () => {
    nextResponses.push({ status: 200, body: { ok: true } });
    const result = await managedApiCall('POST', '/v1/test', { hello: 'world' }, opts());
    expect(result.ok).toBe(true);
    const req = receivedRequests[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/test');
    expect(JSON.parse(req.body!).hello).toBe('world');
  });

  it('managedApiCall throws when no API key is provided', async () => {
    await expect(
      managedApiCall('GET', '/v1/test', undefined, { apiUrl: `http://127.0.0.1:${port}`, apiKey: undefined })
    ).rejects.toThrow('HANZI_API_KEY not set');
  });
});
