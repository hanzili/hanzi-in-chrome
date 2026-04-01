/**
 * `hanzi-browser setup` — auto-detect AI agents and inject MCP config.
 *
 * Scans the machine for Claude Code, Cursor, Windsurf, and Claude Desktop,
 * then merges the Hanzi MCP server entry into each agent's config file.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, cpSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform } from 'os';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { isRelayRunning } from '../relay/auto-start.js';
import { WebSocketClient } from '../ipc/websocket-client.js';
import {
  detectCredentialSources as detectSources,
  checkCredentialFlowResult,
  type DetectOptions,
} from './detect-credentials.js';
import { initTelemetry, trackEvent, shutdownTelemetry } from '../telemetry.js';

// ── Types ──────────────────────────────────────────────────────────────

interface AgentConfig {
  name: string;
  slug: string;
  method: 'json-merge' | 'cli-command';
  detect: () => boolean;
  configPath?: () => string;
  cliCommand?: string;
  skillsDir?: () => string;
}

interface SetupResult {
  agent: string;
  status: 'configured' | 'already-configured' | 'skipped' | 'error';
  detail: string;
}

interface AgentRegistryDeps {
  home?: string;
  plat?: NodeJS.Platform;
  appData?: string;
  pathExists?: (path: string) => boolean;
  runCommand?: (command: string, options?: any) => Buffer | string;
}

interface JsonConfigDeps {
  pathExists?: (path: string) => boolean;
  readTextFile?: (path: string, encoding: BufferEncoding) => string;
  writeTextFile?: (path: string, contents: string) => void;
  ensureDir?: (path: string, options: { recursive: boolean }) => void;
  copyFile?: (source: string, destination: string) => void;
}

interface BrowserDetectionDeps {
  plat?: NodeJS.Platform;
  pathExists?: (path: string) => boolean;
  runCommand?: (command: string, options?: any) => Buffer | string;
}

// ── Style ──────────────────────────────────────────────────────────────

const c = {
  green:   (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow:  (s: string) => `\x1b[33m${s}\x1b[0m`,
  red:     (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim:     (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold:    (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan:    (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const y1 = '\x1b[38;5;178m', y2 = '\x1b[38;5;214m', y3 = '\x1b[38;5;220m', y4 = '\x1b[38;5;221m', y5 = '\x1b[38;5;222m', rs = '\x1b[0m';
const BANNER = `
  ${y1}██   ██${rs} ${y2} █████ ${rs} ${y3}███  ██${rs} ${y4}████████${rs} ${y5}██${rs}
  ${y1}██   ██${rs} ${y2}██   ██${rs} ${y3}████ ██${rs} ${y4}   ██   ${rs} ${y5}██${rs}
  ${y1}███████${rs} ${y2}███████${rs} ${y3}██ ████${rs} ${y4}  ██    ${rs} ${y5}██${rs}
  ${y1}██   ██${rs} ${y2}██   ██${rs} ${y3}██  ███${rs} ${y4} ██     ${rs} ${y5}██${rs}
  ${y1}██   ██${rs} ${y2}██   ██${rs} ${y3}██   ██${rs} ${y4}████████${rs} ${y5}██${rs}
  ${c.dim('browser automation for your ai agent')}
`;

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Plain log for non-interactive mode (no ANSI, no spinners)
function log(msg: string): void {
  // Strip ANSI codes for clean output
  const clean = msg.replace(/\x1b\[[0-9;]*m/g, '');
  console.log(clean);
}

function spinner(text: string, isInteractive = true): { stop: (final: string) => void } {
  if (!isInteractive) {
    log(`  ...  ${text}`);
    return { stop: (final: string) => log(`  ${final}`) };
  }
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r  ${c.cyan(SPINNER_FRAMES[i++ % SPINNER_FRAMES.length])}  ${text}`);
  }, 80);
  return {
    stop: (final: string) => {
      clearInterval(id);
      process.stdout.write(`\r  ${final}\x1b[K\n`);
    },
  };
}

// ── MCP config payload ─────────────────────────────────────────────────

const MCP_ENTRY = {
  command: 'npx',
  args: ['-y', 'hanzi-browse'],
};

// ── Agent registry ─────────────────────────────────────────────────────

export function getAgentRegistry(deps: AgentRegistryDeps = {}): AgentConfig[] {
  const home = deps.home ?? homedir();
  const plat = deps.plat ?? platform();
  const appData = deps.appData ?? process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const pathExists = deps.pathExists ?? existsSync;
  const runCommand = deps.runCommand ?? execSync;

  const hasCli = (bin: string) => {
    try { runCommand(`which ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; }
  };

  return [
    // ── Agents with CLI-based MCP setup ──
    {
      name: 'Claude Code',
      slug: 'claude-code',
      method: 'cli-command',
      cliCommand: 'claude mcp add browser -- npx -y hanzi-browse',
      skillsDir: () => join(home, '.claude', 'skills'),
      detect: () => hasCli('claude'),
    },
    // ── Agents with JSON config merge ──
    {
      name: 'Cursor',
      slug: 'cursor',
      method: 'json-merge',
      configPath: () => join(home, '.cursor', 'mcp.json'),
      skillsDir: () => join(home, '.cursor', 'skills'),
      detect: () => pathExists(join(home, '.cursor')),
    },
    {
      name: 'Windsurf',
      slug: 'windsurf',
      method: 'json-merge',
      configPath: () => join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      skillsDir: () => join(home, '.codeium', 'windsurf', 'skills'),
      detect: () => pathExists(join(home, '.codeium', 'windsurf')),
    },
    {
      name: 'VS Code',
      slug: 'vscode',
      method: 'json-merge',
      configPath: () => join(home, '.vscode', 'mcp.json'),
      skillsDir: () => join(home, '.vscode', 'skills'),
      detect: () => pathExists(join(home, '.vscode')),
    },
    {
      name: 'Codex',
      slug: 'codex',
      method: 'json-merge',
      configPath: () => join(home, '.codex', 'mcp.json'),
      skillsDir: () => join(home, '.agents', 'skills'),
      detect: () => pathExists(join(home, '.codex')) || hasCli('codex'),
    },
    {
      name: 'Claude Desktop',
      slug: 'claude-desktop',
      method: 'json-merge',
      configPath: () => {
        if (plat === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
        if (plat === 'win32') return join(appData, 'Claude', 'claude_desktop_config.json');
        return join(home, '.config', 'Claude', 'claude_desktop_config.json');
      },
      detect: () => {
        if (plat === 'darwin') return pathExists(join(home, 'Library', 'Application Support', 'Claude'));
        if (plat === 'win32') return pathExists(join(appData, 'Claude'));
        return pathExists(join(home, '.config', 'Claude'));
      },
    },
    {
      name: 'Gemini CLI',
      slug: 'gemini',
      method: 'json-merge',
      configPath: () => join(home, '.gemini', 'settings.json'),
      skillsDir: () => join(home, '.gemini', 'skills'),
      detect: () => pathExists(join(home, '.gemini')) || hasCli('gemini'),
    },
    {
      name: 'Amp',
      slug: 'amp',
      method: 'json-merge',
      configPath: () => join(home, '.amp', 'mcp.json'),
      skillsDir: () => join(home, '.amp', 'skills'),
      detect: () => pathExists(join(home, '.amp')),
    },
    {
      name: 'Cline',
      slug: 'cline',
      method: 'json-merge',
      configPath: () => join(home, '.cline', 'mcp_settings.json'),
      detect: () => pathExists(join(home, '.cline')),
    },
    {
      name: 'Roo Code',
      slug: 'roo-code',
      method: 'json-merge',
      configPath: () => join(home, '.roo-code', 'mcp_settings.json'),
      detect: () => pathExists(join(home, '.roo-code')),
    },
  ];
}

// ── JSON merge ─────────────────────────────────────────────────────────

function stripJsonComments(text: string): string {
  return text
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

export function mergeJsonConfig(configPath: string, deps: JsonConfigDeps = {}): SetupResult {
  const agentName = configPath;
  const pathExists = deps.pathExists ?? existsSync;
  const readTextFile = deps.readTextFile ?? readFileSync;
  const writeTextFile = deps.writeTextFile ?? writeFileSync;
  const ensureDir = deps.ensureDir ?? mkdirSync;
  const copyFile = deps.copyFile ?? copyFileSync;

  try {
    if (!pathExists(configPath)) {
      ensureDir(join(configPath, '..'), { recursive: true });
      const config = { mcpServers: { "hanzi-browser": MCP_ENTRY } };
      writeTextFile(configPath, JSON.stringify(config, null, 2) + '\n');
      return { agent: agentName, status: 'configured', detail: `created ${configPath}` };
    }

    const raw = readTextFile(configPath, 'utf-8');
    let config: any;
    try {
      config = JSON.parse(raw);
    } catch {
      try {
        config = JSON.parse(stripJsonComments(raw));
      } catch {
        const bakPath = configPath + '.bak';
        copyFile(configPath, bakPath);
        config = { mcpServers: { "hanzi-browser": MCP_ENTRY } };
        writeTextFile(configPath, JSON.stringify(config, null, 2) + '\n');
        return { agent: agentName, status: 'configured', detail: `backed up malformed config to ${bakPath}` };
      }
    }

    if (config.mcpServers?.["hanzi-browser"]) {
      const existing = config.mcpServers["hanzi-browser"];
      if (existing.command === MCP_ENTRY.command && JSON.stringify(existing.args) === JSON.stringify(MCP_ENTRY.args)) {
        return { agent: agentName, status: 'already-configured', detail: configPath };
      }
    }

    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers["hanzi-browser"] = MCP_ENTRY;
    writeTextFile(configPath, JSON.stringify(config, null, 2) + '\n');
    return { agent: agentName, status: 'configured', detail: `merged into ${configPath}` };
  } catch (err: any) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      return { agent: agentName, status: 'error', detail: `permission denied: ${configPath}` };
    }
    return { agent: agentName, status: 'error', detail: err.message };
  }
}

function runClaudeCodeSetup(): SetupResult {
  try {
    const output = execSync('claude mcp add browser -- npx -y hanzi-browse', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    if (output.toLowerCase().includes('already') || output.toLowerCase().includes('exists')) {
      return { agent: 'Claude Code', status: 'already-configured', detail: 'claude mcp add' };
    }
    return { agent: 'Claude Code', status: 'configured', detail: 'ran: claude mcp add browser' };
  } catch (err: any) {
    const stderr = err.stderr?.toString() || '';
    if (stderr.toLowerCase().includes('already') || stderr.toLowerCase().includes('exists')) {
      return { agent: 'Claude Code', status: 'already-configured', detail: 'claude mcp add' };
    }
    return { agent: 'Claude Code', status: 'error', detail: err.message };
  }
}

// ── Browser detection ──────────────────────────────────────────────────

const EXTENSION_URL = 'https://chromewebstore.google.com/detail/hanzi-browse/iklpkemlmbhemkiojndpbhoakgikpmcd';

interface BrowserInfo {
  name: string;
  slug: string;
  macApp: string;       // macOS .app name
  linuxBin: string;     // Linux binary name
}

const BROWSERS: BrowserInfo[] = [
  { name: 'Google Chrome',   slug: 'chrome',  macApp: 'Google Chrome',   linuxBin: 'google-chrome' },
  { name: 'Brave',           slug: 'brave',   macApp: 'Brave Browser',   linuxBin: 'brave-browser' },
  { name: 'Microsoft Edge',  slug: 'edge',    macApp: 'Microsoft Edge',  linuxBin: 'microsoft-edge' },
  { name: 'Arc',             slug: 'arc',     macApp: 'Arc',             linuxBin: 'arc' },
  { name: 'Chromium',        slug: 'chromium', macApp: 'Chromium',       linuxBin: 'chromium-browser' },
];

export function detectBrowsers(deps: BrowserDetectionDeps = {}): BrowserInfo[] {
  const plat = deps.plat ?? platform();
  const pathExists = deps.pathExists ?? existsSync;
  const runCommand = deps.runCommand ?? execSync;
  return BROWSERS.filter(b => {
    if (plat === 'darwin') {
      return pathExists(`/Applications/${b.macApp}.app`);
    }
    try {
      runCommand(`which ${b.linuxBin}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
}

export function resolveInteractiveMode(options: { yes?: boolean } = {}, stdinIsTTY = process.stdin.isTTY ?? false): boolean {
  return options.yes ? false : stdinIsTTY;
}

function openInBrowser(browser: BrowserInfo, url: string): void {
  const plat = platform();
  try {
    if (plat === 'darwin') {
      execSync(`open -a "${browser.macApp}" "${url}"`, { stdio: 'ignore' });
    } else {
      execSync(`${browser.linuxBin} "${url}" &`, { stdio: 'ignore' });
    }
  } catch {
    // Fallback: system default
    execSync(`open "${url}" 2>/dev/null || xdg-open "${url}" 2>/dev/null`, { stdio: 'ignore' });
  }
}

async function ensureExtension(isInteractive: boolean): Promise<boolean> {
  // Already connected?
  if (await isRelayRunning()) return true;

  // Detect browsers
  const browsers = detectBrowsers();

  if (browsers.length === 0) {
    const msg = `No Chromium browser found. Install the extension manually: ${EXTENSION_URL}`;
    isInteractive
      ? console.log(`  ${c.yellow('●')}  ${msg}\n`)
      : log(`  ●  ${msg}`);
    return false;
  }

  // Pick browser — auto-select first in non-interactive mode
  let browser: BrowserInfo;
  if (!isInteractive || browsers.length === 1) {
    browser = browsers[0];
    isInteractive
      ? console.log(`  ${c.green('✓')}  Found ${c.bold(browser.name)}`)
      : log(`  ✓  Found ${browser.name}`);
  } else {
    console.log(`  ${c.green('✓')}  Found ${c.bold(String(browsers.length))} browsers\n`);
    browsers.forEach((b, i) => {
      console.log(`     ${c.bold(String(i + 1))}  ${b.name}`);
    });
    console.log('');

    const rl = (await import('readline')).createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question(`  ${c.cyan('?')}  Which browser has your logins? (1-${browsers.length}): `, resolve);
    });
    rl.close();

    const idx = parseInt(answer) - 1;
    browser = browsers[idx] || browsers[0];
  }

  // Open Chrome Web Store
  const openMsg = `Opening Chrome Web Store in ${browser.name}...`;
  isInteractive ? console.log(`\n     ${openMsg}\n`) : log(`     ${openMsg}`);
  openInBrowser(browser, EXTENSION_URL);

  // Poll for extension
  const sp = spinner('Waiting for extension to connect...', isInteractive);
  for (let i = 0; i < 90; i++) { // 3 minutes max
    await sleep(2000);
    if (await isRelayRunning()) {
      sp.stop(`${c.green('✓')}  Extension ${c.green('connected')}`);
      return true;
    }
  }

  sp.stop(`${c.yellow('●')}  Timed out waiting for extension`);
  isInteractive
    ? console.log(`     ${c.dim('Install the extension, then run setup again.')}`)
    : log('     Install the extension, then run setup again.');
  return false;
}

// ── Readline ───────────────────────────────────────────────────────────

let rl: ReturnType<typeof createInterface> | null = null;

function ask(prompt: string): Promise<string> {
  if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl!.question(`  ${c.cyan('?')}  ${prompt}`, answer => resolve(answer.trim()));
  });
}

// ── Relay ──────────────────────────────────────────────────────────────

let relay: WebSocketClient | null = null;

async function connectRelay(): Promise<boolean> {
  if (!(await isRelayRunning())) return false;
  try {
    const origError = console.error;
    console.error = () => {};
    relay = new WebSocketClient({
      role: 'cli',
      autoStartRelay: false,
      onDisconnect: () => { relay = null; },
    });
    relay.onMessage(() => {});
    await relay.connect();
    console.error = origError;
    return true;
  } catch {
    console.error = (console as any).__proto__.error;
    relay = null;
    return false;
  }
}

async function sendToExtension(type: string, payload: any): Promise<boolean> {
  if (!relay?.isConnected()) return false;
  try {
    await relay.send({ type: `mcp_${type}`, requestId: randomUUID().slice(0, 8), ...payload });
    await sleep(300);
    return true;
  } catch {
    return false;
  }
}

// ── Credential setup ──────────────────────────────────────────────────

function keychainHas(service: string): boolean {
  if (platform() !== 'darwin') return false;
  try {
    execSync(`security find-generic-password -s "${service}" -w 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function detectCredentialSources() {
  return detectSources({
    platform: platform(),
    homedir: homedir(),
    fileExists: existsSync,
    keychainHas,
  });
}

// ── Access mode choice ───────────────────────────────────────────────

type AccessMode = 'byom' | 'managed' | 'skip';

async function promptAccessMode(isInteractive: boolean): Promise<AccessMode> {
  if (!isInteractive) {
    // Non-interactive: default to BYOM, auto-detect credentials
    return 'byom';
  }

  console.log('');
  console.log(`  ${c.dim('step 3')}  ${c.bold('Access mode')}`);
  console.log(`  ${c.dim('       How should Hanzi access an AI model for browser tasks?')}\n`);

  console.log(`     ${c.bold('1')}  ${c.green('Use my own model')} ${c.dim('(BYOM)')}`);
  console.log(`        ${c.dim('Bring your own Claude, GPT, Gemini, or custom API key.')}`);
  console.log(`        ${c.dim('Everything runs locally — no data leaves your machine.')}`);
  console.log('');
  console.log(`     ${c.bold('2')}  ${c.cyan('Hanzi managed')} ${c.dim('($0.05/task, 20 free/month)')}`);
  console.log(`        ${c.dim('We handle the AI — no API key needed.')}`);
  console.log(`        ${c.dim('Sign in with Google, get 20 free tasks instantly.')}`);
  console.log('');
  console.log(`     ${c.dim('s')}  ${c.dim('Skip — set up later')}`);
  console.log('');

  const choice = await ask('Choose (1/2/s): ');

  if (choice === '2') return 'managed';
  if (choice.toLowerCase() === 's') return 'skip';
  return 'byom'; // default for '1' or anything else
}

// ── Managed access ──────────────────────────────────────────────────

const MANAGED_DASHBOARD_URL = 'https://api.hanzilla.co/dashboard';
const MANAGED_SIGNIN_URL = 'https://api.hanzilla.co/api/auth/sign-in/social';

let managedApiKey: string | null = null;

async function handleManagedAccess(): Promise<void> {
  console.log('');
  console.log(`  ${c.cyan('●')}  ${c.bold('Hanzi managed')}`);
  console.log(`  ${c.dim('     20 free tasks/month. Only completed tasks count.')}\n`);

  console.log(`     Opening your browser to sign in...`);
  openUrl(MANAGED_DASHBOARD_URL);
  console.log(`     ${c.cyan(MANAGED_DASHBOARD_URL)}`);
  console.log('');
  console.log(`     ${c.bold('1.')} Sign in with Google`);
  console.log(`     ${c.bold('2.')} Create an API key in the dashboard`);
  console.log(`     ${c.bold('3.')} Copy and paste it below\n`);

  const key = await ask('  Paste your API key (hic_live_...): ');
  const trimmed = key.trim();

  if (!trimmed || !trimmed.startsWith('hic_live_')) {
    console.log(`\n  ${c.yellow('●')}  Skipped. You can set up managed later by running setup again.`);
    return;
  }

  // Validate the key
  try {
    const res = await fetch(`https://api.hanzilla.co/v1/billing/credits`, {
      headers: { Authorization: `Bearer ${trimmed}` },
    });
    const data = await res.json() as any;
    if (res.ok && data.free_remaining !== undefined) {
      managedApiKey = trimmed;
      console.log(`\n  ${c.green('✓')}  Key validated! ${data.free_remaining} free tasks + ${data.credit_balance || 0} credits available.`);
    } else {
      console.log(`\n  ${c.red('✗')}  Invalid key: ${data.error || 'authentication failed'}`);
      console.log(`     Check the key in your dashboard at ${c.cyan(MANAGED_DASHBOARD_URL)}`);
    }
  } catch (err: any) {
    console.log(`\n  ${c.yellow('●')}  Could not validate key (network error). Saving anyway.`);
    managedApiKey = trimmed;
  }
}

function openUrl(url: string): void {
  try {
    const cmd = platform() === 'darwin' ? `open "${url}"`
      : platform() === 'win32' ? `start "${url}"`
      : `xdg-open "${url}"`;
    execSync(cmd, { stdio: 'ignore' });
  } catch {}
}

/**
 * Re-inject MCP configs with HANZI_API_KEY env var for managed mode.
 * Updates JSON configs directly. For Claude Code, re-runs the CLI command with env.
 */
async function injectManagedKey(apiKey: string, agents: AgentConfig[]): Promise<void> {
  const managedEntry = {
    ...MCP_ENTRY,
    env: { HANZI_API_KEY: apiKey },
  };

  for (const agent of agents) {
    try {
      if (agent.method === 'json-merge' && agent.configPath) {
        const configPath = agent.configPath();
        if (existsSync(configPath)) {
          const raw = readFileSync(configPath, 'utf-8');
          const config = JSON.parse(raw);
          if (config.mcpServers?.["hanzi-browser"]) {
            config.mcpServers["hanzi-browser"] = managedEntry;
            writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
            console.log(`     ${c.green('✓')}  Updated ${agent.name} with managed API key`);
          }
        }
      } else if (agent.method === 'cli-command' && agent.slug === 'claude-code') {
        // Claude Code: remove and re-add with env
        try {
          execSync('claude mcp remove browser', { stdio: 'ignore' });
        } catch {}
        execSync(`claude mcp add browser -e HANZI_API_KEY=${apiKey} -- npx -y hanzi-browse`, {
          stdio: 'ignore',
        });
        console.log(`     ${c.green('✓')}  Updated Claude Code with managed API key`);
      }
    } catch (err: any) {
      console.log(`     ${c.yellow('●')}  Could not update ${agent.name}: ${err.message}`);
    }
  }
}

// ── BYOM credential setup ────────────────────────────────────────────

async function promptByomCredentials(): Promise<void> {
  console.log('');
  console.log(`  ${c.green('●')}  ${c.bold('Bring your own model')}`);
  console.log(`  ${c.dim('     Connect a model source so the extension can run browser tasks.')}\n`);

  // Connect relay for syncing
  await connectRelay();

  // Auto-detect
  const sources = detectCredentialSources();
  let anyImported = false;
  let manualEntryChosen = false;

  if (sources.length > 0) {
    console.log('');
    for (const source of sources) {
      console.log(`     ${c.green('✓')}  Found ${source.name} credentials ${c.dim(source.path)}`);
    }
    for (const source of sources) {
      console.log('');
      const answer = await ask(`Import ${source.name}? (Y/n): `);
      if (answer.toLowerCase() !== 'n') {
        const sp = spinner(`Importing ${source.name}...`);
        const sent = await sendToExtension('import_credentials', { source: source.slug });
        sp.stop(sent
          ? `${c.green('✓')}  ${source.name} imported`
          : `${c.yellow('●')}  Could not sync — import from Chrome extension instead`
        );
        if (sent) anyImported = true;
      }
    }
  }

  // Manual options
  let addMore = sources.length === 0;
  if (sources.length === 0) {
    console.log(`     ${c.dim('No existing credentials found. Add one now:')}`);
  } else {
    console.log('');
    const more = await ask('Add an API key or custom endpoint too? (y/N): ');
    addMore = more.toLowerCase() === 'y';
  }

  while (addMore) {
    console.log('');
    console.log(`     ${c.bold('1')}  API key ${c.dim('(Anthropic, OpenAI, Google, OpenRouter)')}`);
    console.log(`     ${c.bold('2')}  Custom endpoint ${c.dim('(Ollama, LM Studio, etc.)')}`);
    console.log(`     ${c.dim('d')}  ${c.dim('Done')}`);
    console.log('');

    const choice = await ask('(1/2/d): ');

    if (choice === '1') {
      manualEntryChosen = true;
      console.log('');
      console.log(`     ${c.bold('a')} Anthropic  ${c.bold('o')} OpenAI  ${c.bold('g')} Google  ${c.bold('r')} OpenRouter`);
      console.log('');
      const p = await ask('Provider (a/o/g/r): ');
      const map: Record<string, string> = { a: 'anthropic', o: 'openai', g: 'google', r: 'openrouter' };
      const providerId = map[p.toLowerCase()];
      if (providerId) {
        const key = await ask(`${providerId} API key: `);
        if (key) {
          const sp = spinner(`Saving ${providerId} key...`);
          const sent = await sendToExtension('save_config', { payload: { providerKeys: { [providerId]: key } } });
          sp.stop(sent
            ? `${c.green('✓')}  ${providerId} key saved`
            : `${c.yellow('●')}  Could not sync — add from Chrome extension instead`
          );
        }
      }
    } else if (choice === '2') {
      manualEntryChosen = true;
      console.log('');
      const name = await ask('Display name (e.g. "Ollama Llama 3"): ');
      if (name) {
        const baseUrl = await ask('Base URL (e.g. http://localhost:11434/v1): ');
        const modelId = await ask('Model ID (e.g. llama3): ');
        const apiKey = await ask('API key (optional, enter to skip): ');
        if (baseUrl && modelId) {
          const sp = spinner(`Saving ${name}...`);
          const sent = await sendToExtension('save_config', {
            payload: { customModels: [{ name, baseUrl, modelId, apiKey: apiKey || '' }] },
          });
          sp.stop(sent
            ? `${c.green('✓')}  ${name} added`
            : `${c.yellow('●')}  Could not sync — add from Chrome extension instead`
          );
        }
      }
    } else {
      break;
    }
  }

  // Warn if the user went through setup but configured nothing
  const flowResult = checkCredentialFlowResult({
    sourcesDetected: sources.length,
    anyImported,
    manualEntryChosen,
  });
  if (flowResult) {
    console.log('');
    console.log(`  ${c.yellow('●')}  ${flowResult}`);
  }

  disconnectRelay();
}

function disconnectRelay(): void {
  if (relay) {
    const origError = console.error;
    console.error = () => {};
    relay.disconnect();
    relay = null;
    setTimeout(() => { console.error = origError; }, 500);
  }
}

// ── Skill installation ──────────────────────────────────────────────────

function getSkillsSource(): string {
  // Skills are bundled in the npm package at ../skills/ relative to dist/cli/
  const fromDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
  if (existsSync(fromDist)) return fromDist;
  // Fallback: running from source at src/cli/
  const fromSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
  return fromSrc;
}

const SKILL_NAMES = ['hanzi-browse', 'e2e-tester', 'social-poster', 'linkedin-prospector', 'a11y-auditor', 'x-marketer'];

async function installSkills(agents: AgentConfig[], isInteractive: boolean): Promise<void> {
  const skillsSource = getSkillsSource();
  if (!existsSync(skillsSource)) return; // No skills bundled

  const agentsWithSkills = agents.filter(a => a.skillsDir);
  if (agentsWithSkills.length === 0) return;

  const out = isInteractive ? console.log : log;
  if (isInteractive) {
    console.log('');
    console.log(`  ${c.dim('       Installing browser automation skills...')}`);
  } else {
    log('\n     Installing skills...');
  }

  let installed = 0;
  for (const agent of agentsWithSkills) {
    const targetDir = agent.skillsDir!();
    try {
      for (const skillName of SKILL_NAMES) {
        const src = join(skillsSource, skillName);
        if (!existsSync(src)) continue;
        const dest = join(targetDir, skillName);
        mkdirSync(dest, { recursive: true });
        // Copy SKILL.md and any supporting files
        const files = readdirSync(src);
        for (const file of files) {
          copyFileSync(join(src, file), join(dest, file));
        }
      }
      installed++;
      if (isInteractive) {
        console.log(`     ${c.green('✓')}  ${agent.name.padEnd(16)} ${c.dim(targetDir)}`);
      } else {
        log(`     ✓  ${agent.name} (${targetDir})`);
      }
    } catch (err: any) {
      if (isInteractive) {
        console.log(`     ${c.yellow('●')}  ${agent.name.padEnd(16)} ${c.dim(err.message)}`);
      } else {
        log(`     ●  ${agent.name} — ${err.message}`);
      }
    }
  }

  if (installed > 0) {
    const msg = `${installed} agent${installed === 1 ? '' : 's'} got ${SKILL_NAMES.length} browser skills`;
    if (isInteractive) {
      console.log(`\n     ${c.green('✓')}  ${msg}`);
    } else {
      log(`     ✓  ${msg}`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────

export async function runSetup(options: { only?: string; yes?: boolean } = {}): Promise<void> {
  initTelemetry();
  trackEvent("setup_started");

  const registry = getAgentRegistry();
  const only = options.only;
  const interactive = resolveInteractiveMode(options);

  // ── Banner ──
  if (interactive) {
    console.log(BANNER);
  } else {
    log('\nHanzi Setup (non-interactive)\n');
  }

  // ── Step 0: Chrome extension ──
  if (interactive) {
    console.log(`  ${c.dim('step 1')}  ${c.bold('Chrome extension')}`);
    console.log(`  ${c.dim('       Hanzi needs a Chrome extension to control your browser.')}\n`);
  } else {
    log('  Step 1: Chrome extension');
  }

  const sp0 = spinner('Looking for the extension...', interactive);
  if (interactive) await sleep(400);

  const relayUp = await isRelayRunning();
  if (relayUp) {
    sp0.stop(`${c.green('✓')}  Chrome extension is running`);
  } else {
    sp0.stop(`${c.dim('○')}  Chrome extension not found`);
    if (interactive) {
      console.log('');
      await ensureExtension(interactive);
    } else {
      log(`     Install from: ${EXTENSION_URL}`);
    }
  }

  // ── Step 1: Detect agents ──
  if (interactive) {
    console.log('');
    console.log(`  ${c.dim('step 2')}  ${c.bold('MCP server')}`);
    console.log(`  ${c.dim('       Adding Hanzi as an MCP tool to your coding agents.')}\n`);
  } else {
    log('\n  Step 2: MCP server');
  }

  const sp1 = spinner('Scanning for agents on this machine...', interactive);
  if (interactive) await sleep(600);

  const detected: AgentConfig[] = [];
  for (const agent of registry) {
    if (only && agent.slug !== only) continue;
    if (agent.detect()) {
      detected.push(agent);
      trackEvent("setup_agent_detected", { agent: agent.name });
    }
  }

  sp1.stop(interactive
    ? `${c.green('✓')}  Found ${c.bold(String(detected.length))} agent${detected.length === 1 ? '' : 's'} on this machine`
    : `  ✓  Found ${detected.length} agent${detected.length === 1 ? '' : 's'} on this machine`
  );
  const out = interactive ? console.log : log;
  out('');

  for (const agent of registry) {
    if (only && agent.slug !== only) continue;
    const found = detected.includes(agent);
    const path = agent.configPath ? agent.configPath() : '';

    if (interactive) {
      if (found) {
        console.log(`     ${c.green('✓')}  ${agent.name.padEnd(16)} ${c.dim(path)}`);
      } else {
        console.log(`     ${c.dim('○')}  ${c.dim(agent.name)}`);
      }
    } else {
      out(`     ${found ? '✓' : '○'}  ${agent.name}${path ? ` (${path})` : ''}`);
    }
  }

  out('');

  if (detected.length === 0) {
    if (interactive) {
      console.log(`  ${c.yellow('●')}  No agents found. Add this to your agent's MCP config manually:\n`);
      console.log(`     ${c.cyan(JSON.stringify({ mcpServers: { "hanzi-browser": MCP_ENTRY } }))}\n`);
    } else {
      log(`  ●  No agents found. Add manually: ${JSON.stringify({ mcpServers: { "hanzi-browser": MCP_ENTRY } })}`);
    }
    trackEvent("setup_failed", { error_category: "no_agents_detected" });
    await shutdownTelemetry();
    return;
  }

  // ── Step 2: Configure agents ──
  const sp2 = spinner('Adding Hanzi MCP server to each agent...', interactive);
  if (interactive) await sleep(400);

  const results: SetupResult[] = [];
  for (const agent of detected) {
    let result: SetupResult;
    if (agent.method === 'cli-command') {
      result = runClaudeCodeSetup();
    } else {
      result = mergeJsonConfig(agent.configPath!());
    }
    results.push({ ...result, agent: agent.name });
    await sleep(150);
  }

  const configured = results.filter(r => r.status === 'configured').length;
  const alreadyDone = results.filter(r => r.status === 'already-configured').length;

  if (interactive) {
    sp2.stop(`${c.green('✓')}  ${configured > 0 ? `Added to ${c.bold(String(configured))} agent${configured === 1 ? '' : 's'}` : 'All agents already have Hanzi'}`);
    console.log('');
    for (const result of results) {
      if (result.status === 'configured') {
        console.log(`     ${c.green('✓')}  ${result.agent.padEnd(16)} ${c.green('added')}`);
      } else if (result.status === 'already-configured') {
        console.log(`     ${c.dim('●')}  ${result.agent.padEnd(16)} ${c.dim('already has Hanzi')}`);
      } else {
        console.log(`     ${c.red('✗')}  ${result.agent.padEnd(16)} ${c.red(result.detail)}`);
      }
    }
  } else {
    sp2.stop(`  ✓  ${configured > 0 ? `Added to ${configured} agent${configured === 1 ? '' : 's'}` : 'All agents already have Hanzi'}`);
    log('');
    for (const result of results) {
      const status = result.status === 'configured' ? 'added'
        : result.status === 'already-configured' ? 'already has Hanzi'
        : `error: ${result.detail}`;
      log(`     ${result.status === 'error' ? '✗' : result.status === 'configured' ? '✓' : '●'}  ${result.agent} — ${status}`);
    }
  }

  // ── Step 2b: Install skills ──
  await installSkills(detected, interactive);

  // ── Step 3: Access mode ──
  let accessMode: AccessMode = 'byom';

  if (interactive) {
    accessMode = await promptAccessMode(interactive);

    if (accessMode === 'byom') {
      await promptByomCredentials();
    } else if (accessMode === 'managed') {
      await handleManagedAccess();
      // Re-configure agents with HANZI_API_KEY env var
      if (managedApiKey) {
        await injectManagedKey(managedApiKey, detected);
      }
    } else {
      console.log(`\n  ${c.dim('○')}  ${c.dim('Skipped — set up credentials later in the Chrome extension.')}`);
    }
  } else {
    // Non-interactive: auto-detect and report credentials
    const sources = detectCredentialSources();
    if (sources.length > 0) {
      log('\n  Step 3: Credentials (auto-detected)');
      for (const source of sources) {
        log(`     ✓  Found ${source.name} credentials (${source.path})`);
      }
    } else {
      log('\n  Step 3: No credentials auto-detected.');
      log('     Add credentials in the Chrome extension settings or re-run setup interactively.');
    }
  }

  // ── Summary ──
  const errors = results.filter(r => r.status === 'error').length;
  const hasCreds = detectCredentialSources().length > 0;

  if (interactive) {
    console.log('');
    console.log(`  ${c.bold('◆  Setup complete!')}`);
    console.log('');
    if (configured > 0) {
      console.log(`     ${c.green('▸')}  Restart your agents to pick up the new MCP config.`);
    }
    if (accessMode === 'managed' && managedApiKey) {
      console.log(`     ${c.cyan('▸')}  Managed mode configured — 20 free tasks/month.`);
    } else if (hasCreds) {
      console.log(`     ${c.green('▸')}  Credentials detected — Hanzi is ready to use.`);
    } else {
      console.log(`     ${c.yellow('▸')}  No credentials configured yet. Add one in the Chrome extension settings.`);
    }
    if (errors > 0) {
      console.log(`     ${c.red('▸')}  ${errors} agent${errors === 1 ? '' : 's'} failed — check the errors above.`);
    }
    console.log('');
    if (accessMode === 'managed' && managedApiKey) {
      console.log(`  ${c.bold('Try it:')} ask your agent to do something in the browser.`);
      console.log(`  ${c.dim('  Example: "Go to Hacker News and tell me the top 3 stories"')}`);
    } else if (accessMode === 'managed') {
      console.log(`  ${c.bold('Next:')} sign in at ${c.cyan(MANAGED_DASHBOARD_URL)}, create an API key, and re-run setup.`);
    } else if (hasCreds) {
      console.log(`  ${c.bold('Try it:')} ask your agent to do something in the browser.`);
      console.log(`  ${c.dim('  Example: "Go to Hacker News and tell me the top 3 stories"')}`);
    }
    console.log('');
  } else {
    log('\n  Setup complete!');
    if (configured > 0) log(`     Restart your agents to pick up the new MCP config.`);
    if (hasCreds) {
      log('     Credentials detected — Hanzi is ready to use.');
      log('\n  Try it: ask your agent "Go to Hacker News and tell me the top 3 stories"');
    } else {
      log('     No credentials configured yet. Add one in the Chrome extension settings.');
    }
    if (errors > 0) log(`     ${errors} agent(s) failed — check errors above.`);
    log('');
  }

  trackEvent("setup_completed", { agent: detected.map(a => a.name).join(", ") });
  await shutdownTelemetry();

  rl?.close();
  setTimeout(() => process.exit(0), 200);
}
