import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  detectBrowsers,
  getAgentRegistry,
  mergeJsonConfig,
  resolveInteractiveMode,
} from '../src/cli/setup.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hanzi-setup-test-'));
}

describe('getAgentRegistry', () => {
  it('detects configured agents and returns their config paths', () => {
    const seenCommands: string[] = [];
    const cursorDir = join('/Users/tester', '.cursor');
    const vscodeDir = join('/Users/tester', '.vscode');
    const claudeDesktopDir = join('/Users/tester', 'Library', 'Application Support', 'Claude');
    const registry = getAgentRegistry({
      home: '/Users/tester',
      plat: 'darwin',
      appData: '/Users/tester/AppData/Roaming',
      pathExists: (path) => [
        cursorDir,
        vscodeDir,
        claudeDesktopDir,
      ].includes(path),
      runCommand: (command) => {
        seenCommands.push(command);
        if (command === 'which claude' || command === 'which codex') {
          return '';
        }
        throw new Error(`unexpected command: ${command}`);
      },
    });

    expect(registry.find(agent => agent.slug === 'cursor')?.detect()).toBe(true);
    expect(registry.find(agent => agent.slug === 'cursor')?.configPath?.())
      .toBe(join('/Users/tester', '.cursor', 'mcp.json'));
    expect(registry.find(agent => agent.slug === 'vscode')?.detect()).toBe(true);
    expect(registry.find(agent => agent.slug === 'codex')?.detect()).toBe(true);
    expect(registry.find(agent => agent.slug === 'claude-code')?.detect()).toBe(true);
    expect(registry.find(agent => agent.slug === 'claude-desktop')?.configPath?.())
      .toBe(join('/Users/tester', 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    expect(seenCommands).toContain('which claude');
    expect(seenCommands).toContain('which codex');
  });

  it('uses the Windows APPDATA path for Claude Desktop', () => {
    const registry = getAgentRegistry({
      home: 'C:\\Users\\tester',
      plat: 'win32',
      appData: 'C:\\Users\\tester\\AppData\\Roaming',
      pathExists: (path) => path === 'C:\\Users\\tester\\AppData\\Roaming\\Claude',
      runCommand: () => { throw new Error('not installed'); },
    });

    const claudeDesktop = registry.find(agent => agent.slug === 'claude-desktop');
    expect(claudeDesktop?.detect()).toBe(true);
    expect(claudeDesktop?.configPath?.())
      .toBe('C:\\Users\\tester\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
  });
});

describe('mergeJsonConfig', () => {
  it('creates a new config when none exists', () => {
    const dir = makeTempDir();
    try {
      const configPath = join(dir, 'mcp.json');
      const result = mergeJsonConfig(configPath);

      expect(result.status).toBe('configured');
      expect(readFileSync(configPath, 'utf-8')).toContain('"hanzi-browser"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges into an existing config without dropping other MCP servers', () => {
    const dir = makeTempDir();
    try {
      const configPath = join(dir, 'mcp.json');
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          existing: { command: 'node', args: ['existing.js'] },
        },
      }, null, 2));

      const result = mergeJsonConfig(configPath);
      const merged = JSON.parse(readFileSync(configPath, 'utf-8'));

      expect(result.status).toBe('configured');
      expect(merged.mcpServers.existing).toEqual({ command: 'node', args: ['existing.js'] });
      expect(merged.mcpServers['hanzi-browser']).toEqual({
        command: 'npx',
        args: ['-y', 'hanzi-browse'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backs up malformed JSON and writes a fresh config', () => {
    const dir = makeTempDir();
    try {
      const configPath = join(dir, 'mcp.json');
      writeFileSync(configPath, '{"mcpServers": invalid json');

      const result = mergeJsonConfig(configPath);
      const repaired = JSON.parse(readFileSync(configPath, 'utf-8'));

      expect(result.status).toBe('configured');
      expect(result.detail).toContain('.bak');
      expect(readFileSync(configPath + '.bak', 'utf-8')).toContain('invalid json');
      expect(repaired.mcpServers['hanzi-browser']).toEqual({
        command: 'npx',
        args: ['-y', 'hanzi-browse'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns already-configured when the MCP entry already matches', () => {
    const dir = makeTempDir();
    try {
      const configPath = join(dir, 'mcp.json');
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          'hanzi-browser': {
            command: 'npx',
            args: ['-y', 'hanzi-browse'],
          },
        },
      }, null, 2));

      const result = mergeJsonConfig(configPath);

      expect(result.status).toBe('already-configured');
      expect(result.detail).toBe(configPath);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('detectBrowsers', () => {
  it('detects installed browsers on macOS by .app bundle', () => {
    const browsers = detectBrowsers({
      plat: 'darwin',
      pathExists: (path) => [
        '/Applications/Google Chrome.app',
        '/Applications/Arc.app',
      ].includes(path),
    });

    expect(browsers.map(browser => browser.slug)).toEqual(['chrome', 'arc']);
  });

  it('detects installed browsers on Linux by executable lookup', () => {
    const browsers = detectBrowsers({
      plat: 'linux',
      runCommand: (command) => {
        if (command === 'which google-chrome' || command === 'which chromium-browser') {
          return '';
        }
        throw new Error('missing binary');
      },
    });

    expect(browsers.map(browser => browser.slug)).toEqual(['chrome', 'chromium']);
  });
});

describe('resolveInteractiveMode', () => {
  it('forces non-interactive mode when --yes is passed', () => {
    expect(resolveInteractiveMode({ yes: true }, true)).toBe(false);
  });

  it('uses TTY state when --yes is not passed', () => {
    expect(resolveInteractiveMode({}, true)).toBe(true);
    expect(resolveInteractiveMode({}, false)).toBe(false);
  });
});
