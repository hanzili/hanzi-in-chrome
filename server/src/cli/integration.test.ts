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
    // Close stdin immediately so the CLI doesn't block waiting for piped input.
    p.stdin.end();
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

describe('CLI stdout/stderr separation', () => {
  let relay: MockRelay;
  beforeAll(async () => { relay = await MockRelay.start(); });
  afterAll(async () => { await relay.stop(); });

  it('non-json mode: result on stdout, progress/banners on stderr', async () => {
    const startIdx = relay.received.length;
    // Use the same setInterval pattern as the exit-code tests above.
    // When the CLI sends mcp_start_task, emit a task_update then task_complete.
    let emitted = false;
    const timer = setInterval(() => {
      for (let i = startIdx; i < relay.received.length; i++) {
        const msg = relay.received[i];
        if (msg.type === 'mcp_start_task' && !emitted) {
          emitted = true;
          relay.emit({ type: 'task_update', sessionId: msg.sessionId, step: 'visiting linkedin' });
          relay.emit({ type: 'task_complete', sessionId: msg.sessionId, result: 'the answer' });
          return;
        }
      }
    }, 20);
    const { stdout, stderr, code } = await runCli(
      ['start', 'test'],
      { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` },
    );
    clearInterval(timer);
    expect(code).toBe(0);
    expect(stdout).toContain('the answer');
    expect(stdout).not.toContain('visiting linkedin');
    expect(stdout).not.toContain('[CLI]');
    expect(stderr).toContain('visiting linkedin');
    expect(stderr).toContain('[CLI]');
  });
});

describe('Binary consolidation (hanzi-browse dispatches subcommands to CLI)', () => {
  const INDEX = join(__dirname, '..', '..', 'dist', 'index.js');

  async function runIndex(args: string[], timeoutMs = 3000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const p = spawn('node', [INDEX, ...args]);
      let stdout = '', stderr = '';
      p.stdout.on('data', (d: Buffer) => stdout += d);
      p.stderr.on('data', (d: Buffer) => stderr += d);
      const t = setTimeout(() => p.kill(), timeoutMs); // MCP stdio mode waits forever
      p.on('close', (code: number | null) => { clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr }); });
    });
  }

  it('hanzi-browse help routes to CLI help', async () => {
    const { stdout, code } = await runIndex(['help']);
    expect(stdout).toContain('Hanzi Browser CLI'); // heading in cmdHelp today
    expect(code).toBe(0);
  });

  it('hanzi-browse with no args enters MCP stdio mode (no CLI banner)', async () => {
    const { stdout, stderr } = await runIndex([]);
    // CLI help banner starts with "Hanzi Browser CLI"; MCP mode should NOT emit that to stdout.
    expect(stdout).not.toContain('Hanzi Browser CLI');
  });
});

describe('--version', () => {
  it('prints the package version and exits 0', async () => {
    const { stdout, code } = await runCli(['--version']);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(code).toBe(0);
  });

  it('-v is an alias', async () => {
    const { stdout, code } = await runCli(['-v']);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(code).toBe(0);
  });
});

describe('--timeout', () => {
  let relay: MockRelay;
  beforeAll(async () => { relay = await MockRelay.start(); });
  afterAll(async () => { await relay.stop(); });

  it('exits 3 (timeout) after the specified duration', async () => {
    // No task_complete emitted — relay stays silent, CLI should time out.
    const started = Date.now();
    const { code, stderr } = await runCli(
      ['start', 'slow task', '--timeout', '1s'],
      { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` },
    );
    const elapsed = Date.now() - started;
    expect(code).toBe(3);
    expect(stderr).toMatch(/timed out/i);
    expect(elapsed).toBeGreaterThan(900);
    expect(elapsed).toBeLessThan(3500);
  });
});

describe('stdin task support', () => {
  let relay: MockRelay;
  beforeAll(async () => { relay = await MockRelay.start(); });
  afterAll(async () => { await relay.stop(); });

  it('reads the task from stdin when no positional is given', async () => {
    const startIdx = relay.received.length;
    const timer = respondWhenStarted(relay, startIdx, (sessionId) => ({
      type: 'task_complete',
      sessionId,
      result: 'ok',
    }));

    const p = spawn('node', [CLI, 'start'], {
      env: { ...process.env, HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    p.stdin.write('multi-line\ntask from stdin\n');
    p.stdin.end();
    let stderr = '';
    p.stderr.on('data', (d) => stderr += d);
    const code = await new Promise<number>((res) => p.on('close', c => res(c ?? -1)));
    clearInterval(timer);
    expect(code).toBe(0);
    expect(stderr).toContain('multi-line');
  }, 15000);
});

describe('--detach', () => {
  let relay: MockRelay;
  beforeAll(async () => { relay = await MockRelay.start(); });
  afterAll(async () => { await relay.stop(); });

  it('returns session_id on stdout and exits 0 without waiting', async () => {
    const started = Date.now();
    const { code, stdout } = await runCli(
      ['start', 'task', '--detach'],
      { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` },
    );
    const elapsed = Date.now() - started;
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^[a-f0-9]{8}$/);
    expect(elapsed).toBeLessThan(4000);
  });

  it('three parallel --detach starts each return a distinct session_id', async () => {
    const runs = await Promise.all([
      runCli(['start', 'A', '--detach'], { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` }),
      runCli(['start', 'B', '--detach'], { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` }),
      runCli(['start', 'C', '--detach'], { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` }),
    ]);
    const ids = runs.map(r => r.stdout.trim());
    expect(new Set(ids).size).toBe(3);
    runs.forEach(r => expect(r.code).toBe(0));
  });
});

describe('streaming NDJSON in --json mode', () => {
  let relay: MockRelay;
  beforeAll(async () => { relay = await MockRelay.start(); });
  afterAll(async () => { await relay.stop(); });

  it('emits one JSON object per line for task_update, task_complete', async () => {
    const baseline = relay.received.length;
    let emitted = false;
    const sub = setInterval(() => {
      for (let i = baseline; i < relay.received.length; i++) {
        const msg = relay.received[i];
        if (msg.type === 'mcp_start_task' && !emitted) {
          emitted = true;
          relay.emit({ type: 'task_update', sessionId: msg.sessionId, step: 'opening linkedin' });
          relay.emit({ type: 'task_update', sessionId: msg.sessionId, step: 'searching' });
          relay.emit({ type: 'task_complete', sessionId: msg.sessionId, result: 'the answer' });
          clearInterval(sub);
          return;
        }
      }
    }, 20);

    const { stdout, code } = await runCli(
      ['start', 'test', '--json'],
      { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` },
    );
    clearInterval(sub);
    expect(code).toBe(0);
    const lines = stdout.trim().split('\n').map(l => JSON.parse(l));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0].type).toBe('task_update');
    expect(lines.at(-1).type).toBe('task_complete');
    expect(lines.at(-1).status).toBe('complete');
  });
});

describe('--quiet / --verbose', () => {
  let relay: MockRelay;
  beforeAll(async () => { relay = await MockRelay.start(); });
  afterAll(async () => { await relay.stop(); });

  it('--quiet suppresses banners and progress', async () => {
    const startIdx = relay.received.length;
    let emitted = false;
    const sub = setInterval(() => {
      for (let i = startIdx; i < relay.received.length; i++) {
        const msg = relay.received[i];
        if (msg.type === 'mcp_start_task' && !emitted) {
          emitted = true;
          relay.emit({ type: 'task_update', sessionId: msg.sessionId, step: 'visiting' });
          relay.emit({ type: 'task_complete', sessionId: msg.sessionId, result: 'final' });
          return;
        }
      }
    }, 20);

    const { stdout, stderr, code } = await runCli(
      ['start', 'test', '--quiet'],
      { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` },
    );
    clearInterval(sub);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('final');
    expect(stderr).not.toContain('visiting');
    expect(stderr).not.toContain('[CLI]');
  });

  it('--verbose includes [thinking] steps normally suppressed', async () => {
    const startIdx = relay.received.length;
    let emitted = false;
    const sub = setInterval(() => {
      for (let i = startIdx; i < relay.received.length; i++) {
        const msg = relay.received[i];
        if (msg.type === 'mcp_start_task' && !emitted) {
          emitted = true;
          relay.emit({ type: 'task_update', sessionId: msg.sessionId, step: '[thinking] pondering' });
          relay.emit({ type: 'task_complete', sessionId: msg.sessionId, result: 'final' });
          return;
        }
      }
    }, 20);

    const { stderr } = await runCli(
      ['start', 'test', '--verbose'],
      { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` },
    );
    clearInterval(sub);
    expect(stderr).toContain('pondering');
  });
});
