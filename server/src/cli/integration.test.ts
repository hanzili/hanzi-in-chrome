import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'child_process';
import { MockRelay } from './mock-relay.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'dist', 'cli.js');

async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn('node', [CLI, ...args], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => stdout += d);
    p.stderr.on('data', (d) => stderr += d);
    p.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Poll relay.received from `startIdx` until an mcp_start_task appears, then respond. */
function respondWhenStarted(
  relay: MockRelay,
  startIdx: number,
  response: (sessionId: string) => object,
): NodeJS.Timeout {
  return setInterval(() => {
    for (let i = startIdx; i < relay.received.length; i++) {
      const msg = relay.received[i];
      if (msg.type === 'mcp_start_task') {
        relay.emit(response(msg.sessionId));
        return;
      }
    }
  }, 20);
}

describe('CLI exit codes', () => {
  let relay: MockRelay;
  beforeAll(async () => { relay = await MockRelay.start(); });
  afterAll(async () => { await relay.stop(); });

  it('exits 2 on missing task argument', async () => {
    const { code, stderr } = await runCli(['start']);
    expect(code).toBe(2);
    expect(stderr).toContain('Usage');
  });

  it('exits 0 on task_complete', async () => {
    const startIdx = relay.received.length;
    const timer = respondWhenStarted(relay, startIdx, (sessionId) => ({
      type: 'task_complete',
      sessionId,
      result: 'ok',
    }));
    const { code } = await runCli(
      ['start', 'test task complete'],
      { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` },
    );
    clearInterval(timer);
    expect(code).toBe(0);
  });

  it('exits 1 on task_error', async () => {
    const startIdx = relay.received.length;
    const timer = respondWhenStarted(relay, startIdx, (sessionId) => ({
      type: 'task_error',
      sessionId,
      error: 'boom',
    }));
    const { code } = await runCli(
      ['start', 'test task error'],
      { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` },
    );
    clearInterval(timer);
    expect(code).toBe(1);
  });
});
