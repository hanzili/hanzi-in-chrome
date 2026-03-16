/**
 * `hanzi-browser setup` — auto-detect AI agents and inject MCP config.
 *
 * Scans the machine for Claude Code, Cursor, Windsurf, and Claude Desktop,
 * then merges the Hanzi MCP server entry into each agent's config file.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { isRelayRunning } from '../relay/auto-start.js';
import { WebSocketClient } from '../ipc/websocket-client.js';

// ── Types ──────────────────────────────────────────────────────────────

interface AgentConfig {
  name: string;
  slug: string;
  method: 'json-merge' | 'cli-command';
  detect: () => boolean;
  configPath?: () => string;
  cliCommand?: string;
}

interface SetupResult {
  agent: string;
  status: 'configured' | 'already-configured' | 'skipped' | 'error';
  detail: string;
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

function spinner(text: string): { stop: (final: string) => void } {
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
  args: ['-y', 'hanzi-in-chrome'],
};

// ── Agent registry ─────────────────────────────────────────────────────

function getAgentRegistry(): AgentConfig[] {
  const home = homedir();
  const plat = platform();

  return [
    {
      name: 'Claude Code',
      slug: 'claude-code',
      method: 'cli-command',
      cliCommand: 'claude mcp add browser -- npx -y hanzi-in-chrome',
      detect: () => {
        try {
          execSync('which claude', { stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      },
    },
    {
      name: 'Cursor',
      slug: 'cursor',
      method: 'json-merge',
      configPath: () => join(home, '.cursor', 'mcp.json'),
      detect: () => existsSync(join(home, '.cursor')),
    },
    {
      name: 'Windsurf',
      slug: 'windsurf',
      method: 'json-merge',
      configPath: () => join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      detect: () => existsSync(join(home, '.codeium', 'windsurf')),
    },
    {
      name: 'Claude Desktop',
      slug: 'claude-desktop',
      method: 'json-merge',
      configPath: () => {
        if (plat === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
        if (plat === 'win32') return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
        return join(home, '.config', 'Claude', 'claude_desktop_config.json');
      },
      detect: () => {
        if (plat === 'darwin') return existsSync(join(home, 'Library', 'Application Support', 'Claude'));
        if (plat === 'win32') return existsSync(join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude'));
        return existsSync(join(home, '.config', 'Claude'));
      },
    },
  ];
}

// ── JSON merge ─────────────────────────────────────────────────────────

function stripJsonComments(text: string): string {
  return text
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function mergeJsonConfig(configPath: string): SetupResult {
  const agentName = configPath;

  try {
    if (!existsSync(configPath)) {
      mkdirSync(join(configPath, '..'), { recursive: true });
      const config = { mcpServers: { browser: MCP_ENTRY } };
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      return { agent: agentName, status: 'configured', detail: `created ${configPath}` };
    }

    const raw = readFileSync(configPath, 'utf-8');
    let config: any;
    try {
      config = JSON.parse(raw);
    } catch {
      try {
        config = JSON.parse(stripJsonComments(raw));
      } catch {
        const bakPath = configPath + '.bak';
        copyFileSync(configPath, bakPath);
        config = { mcpServers: { browser: MCP_ENTRY } };
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
        return { agent: agentName, status: 'configured', detail: `backed up malformed config to ${bakPath}` };
      }
    }

    if (config.mcpServers?.browser) {
      const existing = config.mcpServers.browser;
      if (existing.command === MCP_ENTRY.command && JSON.stringify(existing.args) === JSON.stringify(MCP_ENTRY.args)) {
        return { agent: agentName, status: 'already-configured', detail: configPath };
      }
    }

    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers.browser = MCP_ENTRY;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
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
    const output = execSync('claude mcp add browser -- npx -y hanzi-in-chrome', {
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

const EXTENSION_URL = 'https://chromewebstore.google.com/detail/hanzi-in-chrome/iklpkemlmbhemkiojndpbhoakgikpmcd';

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

function detectBrowsers(): BrowserInfo[] {
  const plat = platform();
  return BROWSERS.filter(b => {
    if (plat === 'darwin') {
      return existsSync(`/Applications/${b.macApp}.app`);
    }
    try {
      execSync(`which ${b.linuxBin}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
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

async function ensureExtension(): Promise<boolean> {
  // Already connected?
  if (await isRelayRunning()) return true;

  // Detect browsers
  const browsers = detectBrowsers();

  if (browsers.length === 0) {
    console.log(`  ${c.yellow('●')}  No Chromium browser found. Install the extension manually:`);
    console.log(`     ${c.cyan(EXTENSION_URL)}\n`);
    return false;
  }

  // Pick browser
  let browser: BrowserInfo;
  if (browsers.length === 1) {
    browser = browsers[0];
    console.log(`  ${c.green('✓')}  Found ${c.bold(browser.name)}`);
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
  console.log(`\n     Opening Chrome Web Store in ${browser.name}...\n`);
  openInBrowser(browser, EXTENSION_URL);

  // Poll for extension
  const sp = spinner('Waiting for extension to connect...');
  for (let i = 0; i < 90; i++) { // 3 minutes max
    await sleep(2000);
    if (await isRelayRunning()) {
      sp.stop(`${c.green('✓')}  Extension ${c.green('connected')}`);
      return true;
    }
  }

  sp.stop(`${c.yellow('●')}  Timed out waiting for extension`);
  console.log(`     ${c.dim('Install the extension, then run setup again.')}`);
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

function detectCredentialSources(): { name: string; slug: string; path: string }[] {
  const home = homedir();
  const found: { name: string; slug: string; path: string }[] = [];
  const claudePath = join(home, '.claude', '.credentials.json');
  if (existsSync(claudePath)) found.push({ name: 'Claude Code', slug: 'claude', path: claudePath });
  const codexPath = join(home, '.codex', 'auth.json');
  if (existsSync(codexPath)) found.push({ name: 'Codex CLI', slug: 'codex', path: codexPath });
  return found;
}

async function promptCredentials(): Promise<void> {
  console.log('');
  console.log(`  ${c.dim('step 3')}  ${c.bold('Credentials')}`);
  console.log(`  ${c.dim('       Connect a model source so the extension can run browser tasks.')}\n`);

  const skip = await ask('Set up credentials now? Press enter to skip. (y/N): ');
  if (skip.toLowerCase() !== 'y') {
    console.log(`\n  ${c.dim('○')}  ${c.dim('Skipped — set up later in the Chrome extension.')}`);
    return;
  }

  // Connect relay for syncing
  await connectRelay();

  // Auto-detect
  const sources = detectCredentialSources();
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
      }
    }
  }

  // Manual options
  let addMore = sources.length === 0;
  if (!addMore) {
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

  if (relay) {
    const origError = console.error;
    console.error = () => {};
    relay.disconnect();
    relay = null;
    // Restore after a tick so reconnect logs are suppressed
    setTimeout(() => { console.error = origError; }, 500);
  }
}

// ── Main ───────────────────────────────────────────────────────────────

export async function runSetup(options: { only?: string } = {}): Promise<void> {
  const registry = getAgentRegistry();
  const only = options.only;

  // ── Banner ──
  console.log(BANNER);

  // ── Step 0: Chrome extension ──
  console.log(`  ${c.dim('step 1')}  ${c.bold('Chrome extension')}`);
  console.log(`  ${c.dim('       Hanzi needs a Chrome extension to control your browser.')}\n`);

  const sp0 = spinner('Looking for the extension...');
  await sleep(400);

  const relayUp = await isRelayRunning();
  if (relayUp) {
    sp0.stop(`${c.green('✓')}  Chrome extension is running`);
  } else {
    sp0.stop(`${c.dim('○')}  Chrome extension not found`);
    console.log('');
    await ensureExtension();
  }

  // ── Step 1: Detect agents ──
  console.log('');
  console.log(`  ${c.dim('step 2')}  ${c.bold('MCP server')}`);
  console.log(`  ${c.dim('       Adding Hanzi as an MCP tool to your coding agents.')}\n`);

  const sp1 = spinner('Scanning for agents on this machine...');
  await sleep(600);

  const detected: AgentConfig[] = [];
  for (const agent of registry) {
    if (only && agent.slug !== only) continue;
    if (agent.detect()) detected.push(agent);
  }

  sp1.stop(`${c.green('✓')}  Found ${c.bold(String(detected.length))} agent${detected.length === 1 ? '' : 's'} on this machine`);
  console.log('');

  for (const agent of registry) {
    if (only && agent.slug !== only) continue;
    const found = detected.includes(agent);
    const path = agent.configPath ? agent.configPath() : '';

    if (found) {
      console.log(`     ${c.green('✓')}  ${agent.name.padEnd(16)} ${c.dim(path)}`);
    } else {
      console.log(`     ${c.dim('○')}  ${c.dim(agent.name)}`);
    }
  }

  console.log('');

  if (detected.length === 0) {
    console.log(`  ${c.yellow('●')}  No agents found. Add this to your agent's MCP config manually:\n`);
    console.log(`     ${c.cyan(JSON.stringify({ mcpServers: { browser: MCP_ENTRY } }))}\n`);
    return;
  }

  // ── Step 2: Configure agents ──
  const sp2 = spinner('Adding Hanzi MCP server to each agent...');
  await sleep(400);

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

  // ── Step 3: Credentials (skippable) ──
  await promptCredentials();

  // ── Summary ──
  const errors = results.filter(r => r.status === 'error').length;

  console.log('');
  console.log(`  ${c.bold('◆  Setup complete!')}`);
  console.log('');

  if (configured > 0) {
    console.log(`     ${c.green('▸')}  Restart your agents to start using Hanzi.`);
  }

  console.log(`     ${c.green('▸')}  Change credentials anytime in the Chrome extension or sidepanel settings.`);

  if (errors > 0) {
    console.log(`     ${c.red('▸')}  ${errors} agent${errors === 1 ? '' : 's'} failed — check the errors above.`);
  }

  console.log('');
  rl?.close();
  setTimeout(() => process.exit(0), 200);
}
