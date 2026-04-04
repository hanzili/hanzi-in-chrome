import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildBrowserOpenCommand,
  buildSystemOpenCommand,
  detectBrowsers,
  getAgentRegistry,
  mergeJsonConfig,
  mergeJsonConfigAtKey,
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
    // path.join on non-Windows uses '/' — normalize for cross-platform test
    const normalize = (p: string) => p.replace(/[\\/]/g, '/');
    const registry = getAgentRegistry({
      home: 'C:\\Users\\tester',
      plat: 'win32',
      appData: 'C:\\Users\\tester\\AppData\\Roaming',
      pathExists: (path) => normalize(path) === 'C:/Users/tester/AppData/Roaming/Claude',
      runCommand: () => { throw new Error('not installed'); },
    });

    const claudeDesktop = registry.find(agent => agent.slug === 'claude-desktop');
    expect(claudeDesktop?.detect()).toBe(true);
    expect(normalize(claudeDesktop?.configPath?.() ?? ''))
      .toBe('C:/Users/tester/AppData/Roaming/Claude/claude_desktop_config.json');
  });

  it('detects Zed and exposes the official settings path', () => {
    const zedDir = join('/Users/tester', 'Library', 'Application Support', 'Zed');
    const registry = getAgentRegistry({
      home: '/Users/tester',
      plat: 'darwin',
      appData: '/Users/tester/AppData/Roaming',
      pathExists: (path) => path === zedDir,
      runCommand: () => { throw new Error('not installed'); },
    });

    const zed = registry.find(agent => agent.slug === 'zed');
    expect(zed?.detect()).toBe(true);
    expect(zed?.configPath?.())
      .toBe(join('/Users/tester', 'Library', 'Application Support', 'Zed', 'settings.json'));
    expect(zed?.configSection).toBe('context_servers');
  });

  it('detects Neovim via mcphub.nvim and exposes the default servers path', () => {
    const mcphubDir = join('/home/tester', '.config', 'mcphub');
    const registry = getAgentRegistry({
      home: '/home/tester',
      plat: 'linux',
      xdgConfigHome: '/home/tester/.config',
      pathExists: (path) => path === mcphubDir,
      runCommand: () => { throw new Error('not installed'); },
    });

    const neovim = registry.find(agent => agent.slug === 'neovim');
    expect(neovim?.detect()).toBe(true);
    expect(neovim?.configPath?.())
      .toBe(join('/home/tester', '.config', 'mcphub', 'servers.json'));
    expect(neovim?.configSection).toBe('servers');
  });

  it('uses injected XDG_CONFIG_HOME for Linux editor paths', () => {
    const zedDir = join('/tmp/custom-xdg', 'zed');
    const mcphubDir = join('/tmp/custom-xdg', 'mcphub');
    const registry = getAgentRegistry({
      home: '/home/tester',
      plat: 'linux',
      xdgConfigHome: '/tmp/custom-xdg',
      pathExists: (path) => path === zedDir || path === mcphubDir,
      runCommand: () => { throw new Error('not installed'); },
    });

    const zed = registry.find(agent => agent.slug === 'zed');
    const neovim = registry.find(agent => agent.slug === 'neovim');

    expect(zed?.detect()).toBe(true);
    expect(zed?.configPath?.()).toBe(join('/tmp/custom-xdg', 'zed', 'settings.json'));
    expect(neovim?.detect()).toBe(true);
    expect(neovim?.configPath?.()).toBe(join('/tmp/custom-xdg', 'mcphub', 'servers.json'));
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

  it('writes to the requested config section for VS Code-style configs', () => {
    const dir = makeTempDir();
    try {
      const configPath = join(dir, 'mcp.json');
      writeFileSync(configPath, JSON.stringify({
        servers: {
          existing: { command: 'node', args: ['existing.js'] },
        },
      }, null, 2));

      const result = mergeJsonConfigAtKey(configPath, 'servers');
      const merged = JSON.parse(readFileSync(configPath, 'utf-8'));

      expect(result.status).toBe('configured');
      expect(merged.servers.existing).toEqual({ command: 'node', args: ['existing.js'] });
      expect(merged.servers['hanzi-browser']).toEqual({
        command: 'npx',
        args: ['-y', 'hanzi-browse'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates the Hanzi entry from mcpServers to servers for VS Code configs', () => {
    const dir = makeTempDir();
    try {
      const configPath = join(dir, 'mcp.json');
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          'hanzi-browser': { command: 'npx', args: ['-y', 'hanzi-browse'] },
          existingLegacy: { command: 'node', args: ['legacy.js'] },
        },
        servers: {
          existing: { command: 'node', args: ['existing.js'] },
        },
      }, null, 2));

      const result = mergeJsonConfigAtKey(configPath, 'servers', {}, ['mcpServers']);
      const merged = JSON.parse(readFileSync(configPath, 'utf-8'));

      expect(result.status).toBe('configured');
      expect(merged.servers['hanzi-browser']).toEqual({
        command: 'npx',
        args: ['-y', 'hanzi-browse'],
      });
      expect(merged.servers.existing).toEqual({ command: 'node', args: ['existing.js'] });
      expect(merged.mcpServers['hanzi-browser']).toBeUndefined();
      expect(merged.mcpServers.existingLegacy).toEqual({ command: 'node', args: ['legacy.js'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes to context_servers without overwriting other Zed settings', () => {
    const dir = makeTempDir();
    try {
      const configPath = join(dir, 'settings.json');
      writeFileSync(configPath, JSON.stringify({
        theme: 'One Light',
        context_servers: {
          existing: { command: 'node', args: ['existing.js'] },
        },
      }, null, 2));

      const result = mergeJsonConfigAtKey(configPath, 'context_servers');
      const merged = JSON.parse(readFileSync(configPath, 'utf-8'));

      expect(result.status).toBe('configured');
      expect(merged.theme).toBe('One Light');
      expect(merged.context_servers.existing).toEqual({ command: 'node', args: ['existing.js'] });
      expect(merged.context_servers['hanzi-browser']).toEqual({
        command: 'npx',
        args: ['-y', 'hanzi-browse'],
      });
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

  it('detects installed browsers on Windows by executable paths', () => {
    const browsers = detectBrowsers({
      plat: 'win32',
      pathExists: (path) => [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      ].includes(path),
    });

    expect(browsers.map(browser => browser.slug)).toEqual(['chrome', 'edge']);
  });
});

describe('browser open commands', () => {
  it('builds a Windows browser launch command with the detected executable', () => {
    const command = buildBrowserOpenCommand({
      name: 'Google Chrome',
      slug: 'chrome',
      macApp: 'Google Chrome',
      linuxBin: 'google-chrome',
      winPaths: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    }, 'https://example.com', 'win32');

    expect(command).toBe('cmd /c start "" "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "https://example.com"');
  });

  it('builds a Windows fallback command for system default browser', () => {
    expect(buildSystemOpenCommand('https://example.com', 'win32'))
      .toBe('cmd /c start "" "https://example.com"');
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
