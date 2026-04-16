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
    // Use a shorter internal kill timeout (1.5s) so the process's close event
    // fires well before vitest's 5s default test timeout.
    const { stdout } = await runIndex([], 1500);
    // CLI help banner starts with "Hanzi Browser CLI"; MCP mode should NOT emit that to stdout.
    expect(stdout).not.toContain('Hanzi Browser CLI');
  }, 10000);

  // Regression guard: async CLI commands must finish before index.ts's process.exit.
  // Previously `await import('./cli.js'); process.exit(0)` killed doctor mid-flight
  // because the imported module's fire-and-forget main() wasn't awaited.
  it('hanzi-browse doctor --json produces a parseable report (async command completes)', async () => {
    const { stdout, code } = await runIndex(['doctor', '--json'], 8000);
    expect([0, 2]).toContain(code); // doctor exits 2 if relay/creds missing; 0 otherwise
    expect(stdout.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout);
    expect(typeof parsed.extensionConnected).toBe('boolean');
    expect(Array.isArray(parsed.credentials)).toBe(true);
  }, 15000);
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

describe('doctor command', () => {
  it('prints the doctor report', async () => {
    const { stdout } = await runCli(['doctor']);
    expect(stdout).toMatch(/Chrome Extension/);
    expect(stdout).toMatch(/Relay/);
    expect(stdout).toMatch(/credentials/i);
  });

  it('--json outputs machine-readable report', async () => {
    const { stdout } = await runCli(['doctor', '--json']);
    const parsed = JSON.parse(stdout);
    expect(typeof parsed.extensionConnected).toBe('boolean');
    expect(Array.isArray(parsed.credentials)).toBe(true);
  });
});

describe('--skill supports any bundled skill', () => {
  let relay: MockRelay;
  beforeAll(async () => { relay = await MockRelay.start(); });
  afterAll(async () => { await relay.stop(); });

  it('accepts x-marketer (not just the 3 formerly hardcoded)', async () => {
    const baseline = relay.received.length;
    let emitted = false;
    const sub = setInterval(() => {
      for (let i = baseline; i < relay.received.length; i++) {
        const msg = relay.received[i];
        if (msg.type === 'mcp_start_task' && !emitted) {
          emitted = true;
          relay.emit({ type: 'task_complete', sessionId: msg.sessionId, result: 'ok' });
          clearInterval(sub);
          return;
        }
      }
    }, 20);

    const { code } = await runCli(
      ['start', 'find trending X posts in AI', '--skill', 'x-marketer'],
      { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` },
    );
    clearInterval(sub);
    expect(code).toBe(0);
    const startMsg = relay.received.find(m => m.type === 'mcp_start_task' && m.task?.includes('find trending'));
    expect(startMsg).toBeDefined();
    // Skill prompt was loaded — context should contain some characteristic text
    expect(startMsg!.context).toBeTruthy();
    expect(typeof startMsg!.context).toBe('string');
    expect(startMsg!.context.length).toBeGreaterThan(50);
  });

  it('rejects an unknown skill with a clear error listing alternatives', async () => {
    const { code, stderr } = await runCli(
      ['start', 'task', '--skill', 'does-not-exist-xyz'],
    );
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown skill');
    expect(stderr).toContain('Available:');
  });
});

import { createServer as createHttpServer } from 'http';
import type { Server as HttpServer } from 'http';
import { mkdtempSync, existsSync as fsExists, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('skills install — local first', () => {
  it('installs hanzi-browse from bundled source by default (no network)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hanzi-skill-'));
    try {
      // Use cwd override so detectSkillsDir plants under a temp dir we control.
      // runCli runs with default cwd, so install will land under the worktree's
      // .agents/skills (existing) — to keep the test hermetic, we verify exit
      // code + stdout message instead of asserting file path.
      const { code, stdout } = await runCli(['skills', 'install', 'hanzi-browse']);
      expect(code).toBe(0);
      expect(stdout.toLowerCase()).toMatch(/installed hanzi-browse/);
      expect(stdout.toLowerCase()).toContain('bundled');
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  });

  it('rejects unknown skill name with clear error', async () => {
    const { code, stderr } = await runCli(['skills', 'install', 'nonexistent-xyz-skill']);
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown skill');
    expect(stderr).toContain('Bundled:');
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

describe('end-to-end: parallel detached tasks + status --json', () => {
  let relay: MockRelay;
  beforeAll(async () => { relay = await MockRelay.start(); });
  afterAll(async () => { await relay.stop(); });

  it('runs 3 parallel --detach starts, then reads each via status --json', async () => {
    const starts = await Promise.all([
      runCli(['start', 'A', '--detach'], { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` }),
      runCli(['start', 'B', '--detach'], { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` }),
      runCli(['start', 'C', '--detach'], { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` }),
    ]);
    const ids = starts.map(s => s.stdout.trim());
    expect(new Set(ids).size).toBe(3);
    starts.forEach(s => expect(s.code).toBe(0));

    for (const id of ids) {
      const { stdout, code } = await runCli(['status', id, '--json']);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.session_id).toBe(id);
    }
  });
});

describe('CLI managed mode (HANZI_API_KEY routes to api.hanzilla.co)', () => {
  let server: HttpServer;
  let port: number;
  let nextResponses: Array<{ status: number; body: any }> = [];

  beforeAll(async () => {
    server = createHttpServer((req, res) => {
      const next = nextResponses.shift() ?? { status: 200, body: {} };
      res.writeHead(next.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(next.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as any).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => { nextResponses = []; });

  it('routes to managed API when HANZI_API_KEY is set and returns result', async () => {
    // GET /v1/browser-sessions → connected session
    nextResponses.push({ status: 200, body: { sessions: [{ id: 'sess1', status: 'connected' }] } });
    // POST /v1/tasks → task created (running)
    nextResponses.push({ status: 200, body: { id: 'task1', status: 'running' } });
    // GET /v1/tasks/task1 → complete
    nextResponses.push({ status: 200, body: { id: 'task1', status: 'complete', answer: 'the page title', steps: 5 } });

    const { code, stdout } = await runCli(
      ['start', 'return the page title', '--url', 'https://example.com', '--timeout', '10s'],
      { HANZI_API_KEY: 'test-key', HANZI_API_URL: `http://127.0.0.1:${port}` },
    );
    expect(code).toBe(0);
    expect(stdout).toContain('the page title');
  }, 15000);

  it('exits 1 when managed API reports task error', async () => {
    // GET /v1/browser-sessions → connected session
    nextResponses.push({ status: 200, body: { sessions: [{ id: 'sess1', status: 'connected' }] } });
    // POST /v1/tasks → task created (running)
    nextResponses.push({ status: 200, body: { id: 'task1', status: 'running' } });
    // GET /v1/tasks/task1 → error
    nextResponses.push({ status: 200, body: { id: 'task1', status: 'error', answer: 'something broke', steps: 0 } });

    const { code } = await runCli(
      ['start', 'x', '--timeout', '10s'],
      { HANZI_API_KEY: 'test-key', HANZI_API_URL: `http://127.0.0.1:${port}` },
    );
    expect(code).toBe(1);
  }, 15000);
});

describe('CLI timeout exit code via hanzi-browse dispatch', () => {
  const INDEX = join(__dirname, '..', '..', 'dist', 'index.js');
  let relay: MockRelay;

  beforeAll(async () => { relay = await MockRelay.start(); });
  afterAll(async () => { await relay.stop(); });

  async function runIndex(
    args: string[],
    env: Record<string, string> = {},
    timeoutMs = 10000,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const p = spawn('node', [INDEX, ...args], { env: { ...process.env, ...env } });
      p.stdin.end();
      let stdout = '', stderr = '';
      p.stdout.on('data', (d: Buffer) => stdout += d);
      p.stderr.on('data', (d: Buffer) => stderr += d);
      const t = setTimeout(() => p.kill(), timeoutMs);
      p.on('close', (code: number | null) => { clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr }); });
    });
  }

  it('exits 3 when task times out via hanzi-browse binary dispatch', async () => {
    // Relay is running but never sends task_complete — CLI times out, exit 3.
    // The synchronous process.exit(3) in disconnectAndExit must win over the
    // process.exit(0) that index.ts issues after `await main()`.
    const { code, stderr } = await runIndex(
      ['start', 'slow', '--timeout', '1s'],
      { HANZI_RELAY_URL: `ws://127.0.0.1:${relay.port}` },
      10000,
    );
    expect(code).toBe(3);
    expect(stderr).toMatch(/timed out/i);
  }, 15000);
});
