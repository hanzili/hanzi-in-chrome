#!/usr/bin/env node

/**
 * LLM Browser CLI
 *
 * Command-line interface for browser automation.
 * Sends tasks to the Chrome extension via WebSocket relay.
 *
 * Usage:
 *   hanzi-browser start "task" --url https://example.com
 *   hanzi-browser status [session_id]
 *   hanzi-browser message <session_id> "message"
 *   hanzi-browser logs <session_id> [--follow]
 *   hanzi-browser stop <session_id> [--remove]
 *   hanzi-browser screenshot <session_id>
 */

import { existsSync, readFileSync, mkdirSync, watch, writeFileSync, copyFileSync, readdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';

import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { discoverBundledSkills, type SkillMeta } from './cli/skills-discovery.js';
import { WebSocketClient } from './ipc/websocket-client.js';
import { EXIT_OK, EXIT_TASK_ERROR, EXIT_CLI_ERROR, EXIT_TIMEOUT } from './cli/exit-codes.js';
import { IS_MANAGED_MODE, MANAGED_API_URL } from './cli/managed-client.js';
import { parseDuration } from './cli/arg-parser.js';
import {
  writeSessionStatus,
  readSessionStatus,
  appendSessionLog,
  listSessions,
  deleteSessionFiles,
  getSessionLogPath,
  getSessionScreenshotPath,
  pruneOldSessions,
  type SessionFileStatus,
} from './cli/session-files.js';
import {
  buildScreenshotPayload,
  buildStatusPayload,
  buildStopPayload,
  buildTaskCompletePayload,
  buildTaskErrorPayload,
} from './cli/json-output.js';

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];
const jsonOutput = args.includes('--json');
const quietMode = args.includes('--quiet') || args.includes('-q');
const verboseMode = args.includes('--verbose');

let connection: WebSocketClient;

// Track completion for blocking start
type TaskOutcome = 'complete' | 'error' | 'timeout';
let pendingOutcome: TaskOutcome | null = null;
let pendingResolve: (() => void) | null = null;
let activeSessionId: string | null = null;
let pendingScreenshotResolve: ((data: string) => void) | null = null;

async function initConnection(): Promise<void> {
  if (connection?.isConnected()) return;

  connection = new WebSocketClient({
    role: 'cli',
    autoStartRelay: true,
    onDisconnect: quietMode ? undefined : () => console.error('[CLI] Relay connection lost, will reconnect'),
    quiet: quietMode,
  });

  connection.onMessage(handleMessage);
  await connection.connect();
  if (!quietMode) console.error('[CLI] Connected to WebSocket relay');
}

function handleMessage(message: any): void {
  const { type, sessionId, ...data } = message;
  if (!sessionId) return;

  // Only process events for the session this CLI instance started.
  // Without this, all relay-connected CLI processes would write
  // logs/status for every session, causing duplicates.
  if (!activeSessionId || sessionId !== activeSessionId) return;

  const step = data.step || data.status || data.message;

  switch (type) {
    case 'task_update':
      if (step) {
        const isThinking = step === 'thinking' || step.startsWith('[thinking]');
        if (!isThinking || verboseMode) {
          appendSessionLog(sessionId, step);
          writeSessionStatus(sessionId, { status: 'running' });
          if (jsonOutput) {
            console.log(JSON.stringify({ type: 'task_update', session_id: sessionId, step }));
          } else if (!quietMode) {
            console.error(`  ${step.slice(0, 100)}`);
          }
        }
      }
      break;

    case 'task_complete': {
      const raw = step || data.result || 'Task completed';
      const result = typeof raw === 'object' ? raw : String(raw);
      const answer = typeof result === 'object' ? JSON.stringify(result, null, 2) : result;
      appendSessionLog(sessionId, `[COMPLETE] ${answer}`);
      writeSessionStatus(sessionId, { status: 'complete', result: answer });
      if (jsonOutput) {
        console.log(JSON.stringify({ type: 'task_complete', ...buildTaskCompletePayload(sessionId, result) }));
      } else {
        if (!quietMode) console.error(`\n[CLI] Task completed: ${sessionId}`);
        console.log(answer);
      }
      pendingOutcome = 'complete';
      pendingResolve?.();
      break;
    }

    case 'task_error':
      appendSessionLog(sessionId, `[ERROR] ${data.error}`);
      writeSessionStatus(sessionId, { status: 'error', error: data.error });
      if (jsonOutput) {
        console.log(JSON.stringify({ type: 'task_error', ...buildTaskErrorPayload(sessionId, data.error) }));
      } else {
        console.error(`\n[CLI] Task error: ${data.error}`);
      }
      pendingOutcome = 'error';
      pendingResolve?.();
      break;

    case 'screenshot':
      if (data.data && pendingScreenshotResolve) {
        pendingScreenshotResolve(data.data);
        pendingScreenshotResolve = null;
      }
      break;
  }
}

async function waitForTaskCompletion(timeoutMs = 5 * 60 * 1000): Promise<TaskOutcome> {
  return new Promise<TaskOutcome>((resolve) => {
    pendingResolve = () => resolve(pendingOutcome ?? 'complete');
    setTimeout(() => {
      console.error(`\n[CLI] Task timed out after ${Math.round(timeoutMs / 60000)} minutes`);
      resolve('timeout');
    }, timeoutMs);
  });
}

function outcomeToExitCode(outcome: TaskOutcome): number {
  switch (outcome) {
    case 'complete': return EXIT_OK;
    case 'error':    return EXIT_TASK_ERROR;
    case 'timeout':  return EXIT_TIMEOUT;
  }
}

function disconnectAndExit(code = EXIT_OK): never {
  connection?.disconnect();
  process.exit(code);
}

// --- Commands ---

function loadSkillPrompt(skillName: string): string | null {
  const skill = discoverBundledSkills().find(s => s.name === skillName);
  if (!skill) return null;
  const mdPath = join(skill.path, 'SKILL.md');
  if (!existsSync(mdPath)) return null;
  const content = readFileSync(mdPath, 'utf-8');
  return content.replace(/^---[\s\S]*?---\n*/m, '').trim();
}

async function cmdStart(): Promise<void> {
  let task = args[1];

  if (!task && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    task = Buffer.concat(chunks).toString('utf-8').trim();
  }

  if (!task) {
    console.error('Usage: hanzi-browse start "task description" [--url URL] [--context TEXT] [--skill NAME] [--timeout 5m]');
    console.error('       echo "task" | hanzi-browse start   (also works)');
    process.exit(EXIT_CLI_ERROR);
  }

  let url: string | undefined;
  let context: string | undefined;
  let skill: string | undefined;
  let timeoutMs = 5 * 60 * 1000; // default 5 min
  const detach = args.includes('--detach') || args.includes('-d');

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--url' || args[i] === '-u') url = args[++i];
    else if (args[i] === '--context' || args[i] === '-c') context = args[++i];
    else if (args[i] === '--skill' || args[i] === '-s') skill = args[++i];
    else if (args[i] === '--timeout' || args[i] === '-t') {
      try { timeoutMs = parseDuration(args[++i]); }
      catch (e: any) {
        console.error(`Invalid --timeout: ${e.message}`);
        process.exit(EXIT_CLI_ERROR);
      }
    }
  }

  // Inject skill prompt as context
  if (skill) {
    const skillPrompt = loadSkillPrompt(skill);
    if (!skillPrompt) {
      const available = discoverBundledSkills().map(s => s.name).join(', ');
      console.error(`Unknown skill: ${skill}`);
      console.error(`Available: ${available}`);
      process.exit(EXIT_CLI_ERROR);
    }
    context = context
      ? `${skillPrompt}\n\n---\n\nAdditional context: ${context}`
      : skillPrompt;
  }

  // Managed mode: route to api.hanzilla.co instead of local relay.
  if (IS_MANAGED_MODE) {
    if (detach && !quietMode) {
      console.error('[CLI] --detach not yet supported in managed mode — running blocking');
    }
    if (!quietMode && !jsonOutput) {
      console.error(`[CLI] Managed mode — dispatching to ${MANAGED_API_URL}`);
    }
    const { runManagedTask } = await import('./cli/managed-client.js');
    let result;
    try {
      result = await runManagedTask(task, url, context, timeoutMs);
    } catch (err: any) {
      console.error(`[CLI] Managed API error: ${err.message}`);
      process.exit(EXIT_CLI_ERROR);
    }
    const sid = `managed-${Date.now().toString(36).slice(-8)}`;
    writeSessionStatus(sid, {
      session_id: sid,
      status: result.status === 'complete' ? 'complete' : result.status === 'timeout' ? 'running' : 'error',
      task, url, context,
      result: result.answer,
      error: result.error,
    });
    if (jsonOutput) {
      console.log(JSON.stringify({
        type: 'task_complete',
        session_id: sid,
        status: result.status,
        result: result.answer,
        steps: result.steps,
        error: result.error,
      }));
    } else {
      if (!quietMode) console.error(`\n[CLI] Task ${result.status} after ${result.steps} steps`);
      console.log(result.answer);
    }
    const code = result.status === 'complete' ? EXIT_OK
      : result.status === 'timeout' ? EXIT_TIMEOUT
      : EXIT_TASK_ERROR;
    process.exit(code);
  }

  if (!jsonOutput && !quietMode) {
    console.error('[CLI] Starting browser task...');
    console.error(`  Task: ${task}`);
    if (url) console.error(`  URL: ${url}`);
    if (context) console.error(`  Context: ${context.substring(0, 50)}...`);
  }

  await initConnection();

  const sessionId = randomUUID().slice(0, 8);
  activeSessionId = sessionId;

  writeSessionStatus(sessionId, {
    session_id: sessionId,
    status: 'running',
    task,
    url,
    context,
  });

  await connection.send({
    type: 'mcp_start_task',
    sessionId,
    task,
    url,
    context,
  });

  if (detach) {
    if (jsonOutput) {
      console.log(JSON.stringify({ session_id: sessionId, status: 'detached' }));
    } else {
      console.log(sessionId);
    }
    disconnectAndExit(EXIT_OK);
    return;
  }

  if (!jsonOutput && !quietMode) {
    console.error(`\n[CLI] Session: ${sessionId}`);
    console.error(`  Status: ~/.hanzi-browse/sessions/${sessionId}.json`);
    console.error(`  Logs:   ~/.hanzi-browse/sessions/${sessionId}.log`);
    console.error(`  Skills: run \`hanzi-browser skills\` for optimized workflows (e.g. LinkedIn prospecting)`);
    console.error('\nWaiting for completion...\n');
  }

  // Block until task completes
  const outcome = await waitForTaskCompletion(timeoutMs);
  disconnectAndExit(outcomeToExitCode(outcome));
}

function cmdStatus(): void {
  const sessionId = args[1]?.startsWith('--') ? undefined : args[1];

  if (sessionId) {
    const status = readSessionStatus(sessionId);
    if (!status) {
      console.error(`Session not found: ${sessionId}`);
      process.exit(EXIT_CLI_ERROR);
    }
    console.log(JSON.stringify(buildStatusPayload(status), jsonOutput ? undefined : null, jsonOutput ? undefined : 2));
  } else {
    pruneOldSessions(); // opportunistic cleanup
    const allSessions = listSessions();
    if (jsonOutput) {
      console.log(JSON.stringify(buildStatusPayload(allSessions)));
    } else if (allSessions.length === 0) {
      console.log('No sessions found.');
    } else {
      console.log(`Found ${allSessions.length} session(s):\n`);
      for (const s of allSessions) {
        const taskPreview = s.task ? s.task.substring(0, 55) : '(no task)';
        console.log(`  ${s.session_id.padEnd(10)} ${s.status.padEnd(10)} ${taskPreview}`);
      }
    }
  }
}

async function cmdMessage(): Promise<void> {
  const sessionId = args[1];
  const message = args[2];
  let timeoutMs = 5 * 60 * 1000;

  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--timeout' || args[i] === '-t') {
      try { timeoutMs = parseDuration(args[++i]); }
      catch (e: any) {
        console.error(`Invalid --timeout: ${e.message}`);
        process.exit(EXIT_CLI_ERROR);
      }
    }
  }

  if (!sessionId || !message) {
    console.error('Usage: hanzi-browser message <session_id> "message" [--timeout 5m]');
    process.exit(EXIT_CLI_ERROR);
  }

  activeSessionId = sessionId;
  await initConnection();
  await connection.send({ type: 'mcp_send_message', sessionId, message });
  appendSessionLog(sessionId, `[USER] ${message}`);
  console.error(`Message sent to session ${sessionId}`);
  console.error('Waiting for completion...\n');
  const outcome = await waitForTaskCompletion(timeoutMs);
  disconnectAndExit(outcomeToExitCode(outcome));
}

function cmdLogs(): void {
  const sessionId = args[1];
  const follow = args.includes('--follow') || args.includes('-f');

  if (!sessionId) {
    console.error('Usage: hanzi-browser logs <session_id> [--follow]');
    process.exit(EXIT_CLI_ERROR);
  }

  const logPath = getSessionLogPath(sessionId);
  if (!existsSync(logPath)) {
    console.error(`Log file not found: ${logPath}`);
    process.exit(EXIT_CLI_ERROR);
  }

  const content = readFileSync(logPath, 'utf-8');
  console.log(content.split('\n').slice(-50).join('\n'));

  if (follow) {
    console.log('\n--- Watching for new logs (Ctrl+C to stop) ---\n');
    let lastSize = content.length;
    const watcher = watch(logPath, () => {
      const newContent = readFileSync(logPath, 'utf-8');
      if (newContent.length > lastSize) {
        process.stdout.write(newContent.slice(lastSize));
        lastSize = newContent.length;
      }
    });
    process.on('SIGINT', () => { watcher.close(); process.exit(0); });
  }
}

async function cmdStop(): Promise<void> {
  const sessionId = args[1];
  const remove = args.includes('--remove') || args.includes('-r');

  if (!sessionId) {
    console.error('Usage: hanzi-browser stop <session_id> [--remove]');
    process.exit(EXIT_CLI_ERROR);
  }

  activeSessionId = sessionId;
  await initConnection();
  await connection.send({ type: 'mcp_stop_task', sessionId, remove });

  if (remove) {
    deleteSessionFiles(sessionId);
    if (jsonOutput) {
      console.log(JSON.stringify(buildStopPayload(sessionId, true)));
    } else {
      console.log(`Session ${sessionId} stopped and removed.`);
    }
  } else {
    writeSessionStatus(sessionId, { status: 'stopped' });
    if (jsonOutput) {
      console.log(JSON.stringify(buildStopPayload(sessionId, false)));
    } else {
      console.log(`Session ${sessionId} stopped.`);
    }
  }
  disconnectAndExit(0);
}

async function cmdScreenshot(): Promise<void> {
  const sessionId = args[1];
  const requestId = sessionId || `screenshot-${Date.now()}`;
  activeSessionId = requestId;
  await initConnection();
  await connection.send({ type: 'mcp_screenshot', sessionId: requestId });
  if (!jsonOutput) {
    console.log(`Screenshot requested for ${requestId}. Waiting for image...\n`);
  }

  const data = await new Promise<string | null>((resolve) => {
    pendingScreenshotResolve = resolve;
    setTimeout(() => {
      pendingScreenshotResolve = null;
      resolve(null);
    }, 10000);
  });

  if (!data) {
    console.error('[CLI] Screenshot timed out');
    disconnectAndExit(EXIT_CLI_ERROR);
    return;
  }

  const screenshotPath = getSessionScreenshotPath(requestId);
  writeFileSync(screenshotPath, Buffer.from(data, 'base64'));
  if (jsonOutput) {
    console.log(JSON.stringify(buildScreenshotPayload(requestId, screenshotPath)));
  } else {
    console.log(`[CLI] Screenshot saved: ${screenshotPath}`);
  }
  disconnectAndExit(0);
}

// --- Skills ---

const SKILLS_BASE_URL = 'https://raw.githubusercontent.com/hanzili/hanzi-browse/main/server/skills';

async function cmdSkills(): Promise<void> {
  const skills = discoverBundledSkills();
  const subcommand = args[1];

  if (subcommand === 'install') {
    const skillName = args[2];
    const useLatest = args.includes('--latest');
    if (!skillName) {
      console.error('Usage: hanzi-browse skills install <name> [--latest]');
      process.exit(EXIT_CLI_ERROR);
    }
    if (useLatest) {
      await installSkillFromGitHub(skillName);
    } else {
      const skill = skills.find(s => s.name === skillName);
      if (!skill) {
        console.error(`Unknown skill: ${skillName}`);
        console.error(`Bundled: ${skills.map(s => s.name).join(', ')}`);
        console.error(`Try --latest to fetch from GitHub.`);
        process.exit(EXIT_CLI_ERROR);
      }
      await installSkillFromLocal(skill);
    }
    return;
  }

  console.log('\nAvailable skills:\n');
  for (const skill of skills) {
    console.log(`  ${skill.name.padEnd(28)} [${skill.category}] ${skill.description.slice(0, 80)}`);
  }
  console.log(`\nInstall: hanzi-browse skills install <name>`);
  console.log(`Browse:  https://browse.hanzilla.co/skills\n`);
}

async function installSkillFromLocal(skill: SkillMeta): Promise<void> {
  const targetDir = detectSkillsDir(skill.name);
  mkdirSync(targetDir, { recursive: true });
  for (const file of readdirSync(skill.path)) {
    try { copyFileSync(join(skill.path, file), join(targetDir, file)); } catch {}
  }
  console.log(`Installed ${skill.name} (bundled) → ${targetDir}`);
}

async function installSkillFromGitHub(skillName: string): Promise<void> {
  const targetDir = detectSkillsDir(skillName);
  mkdirSync(targetDir, { recursive: true });

  const url = `${SKILLS_BASE_URL}/${skillName}/SKILL.md`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const content = await response.text();
    writeFileSync(join(targetDir, 'SKILL.md'), content);
    console.log(`Installed ${skillName} (latest) → ${targetDir}`);
  } catch (err: any) {
    console.error(`Failed to fetch ${skillName}: ${err.message}`);
    process.exit(EXIT_CLI_ERROR);
  }
}

function detectSkillsDir(skillName: string): string {
  // Check for common agent skill directories in the current project
  // Priority: .agents/skills (universal) > .claude/skills (Claude Code) > .cursor/rules (Cursor)
  if (existsSync('.agents/skills') || existsSync('.agents')) {
    return join('.agents', 'skills', skillName);
  }
  if (existsSync('.claude/skills') || existsSync('.claude')) {
    return join('.claude', 'skills', skillName);
  }
  // Default to .agents/skills (most portable)
  return join('.agents', 'skills', skillName);
}

async function cmdDoctor(): Promise<void> {
  const { runDoctor, renderDoctorReport } = await import('./cli/doctor.js');
  const report = await runDoctor();
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderDoctorReport(report));
  }
  // Exit non-zero if anything critical is off
  const ok = report.relayReachable && report.credentials.length > 0;
  process.exit(ok ? EXIT_OK : EXIT_CLI_ERROR);
}

async function cmdSetup(): Promise<void> {
  const { runSetup } = await import('./cli/setup.js');
  let only: string | undefined;
  let yes = false;
  let all = false;
  let skills: string[] | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--only' && args[i + 1]) only = args[++i];
    else if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--all-skills' || arg === '--all') all = true;
    else if (arg === '--skills' && args[i + 1]) {
      skills = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--skills=')) {
      skills = arg.slice('--skills='.length).split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  await runSetup({ only, yes, all, skills });
}

function cmdVersion(): void {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  console.log(pkg.version);
  process.exit(0);
}

function cmdHelp(): void {
  console.log(`
Hanzi Browser CLI - Browser automation from the command line

Controls your real Chrome browser with your existing logins, cookies, and
sessions. Good for authenticated sites, dynamic pages, and multi-step tasks
that need a real browser.

Usage:
  hanzi-browser <command> [options]

Commands:
  start <task>              Start a browser automation task
    --url, -u <url>         Starting URL
    --context, -c <text>    Context information for the task
    --skill, -s <name>      Use a bundled skill (e.g. linkedin-prospector)
    --detach, -d            Return session_id immediately and exit 0 (non-blocking).
                            Useful for running multiple tasks in parallel.
                            Check progress with \`status\` or \`logs\`.
                            Blocks until complete or timeout by default.
                            Each session gets its own browser window.

  status [session_id]       Show status of session(s)
    --json                  Output machine-readable JSON

  message <session_id> <msg>  Send follow-up instructions to a session
                              Reuses the same browser window and page state.

  logs <session_id>         Show logs for a session
    --follow, -f            Watch logs in real-time

  stop <session_id>         Stop a session
    --remove, -r            Also delete session files
    --json                  Output machine-readable JSON

  screenshot [session_id]   Take a screenshot
    --json                  Output machine-readable JSON

  setup                     Auto-detect AI agents and configure MCP
    --only <agent>          Only configure one agent (claude-code, cursor, windsurf, claude-desktop)
    --yes, -y               Non-interactive mode (installs core skill only)
    --all                   Install every bundled skill (skip the prompt)
    --skills a,b,c          Install just these skills (core always included)

  skills                    List available agent skills
  skills install <name>     Download a skill into your project

  doctor                    Diagnose setup (extension, credentials, API, recent sessions)
    --json                  Output machine-readable JSON

  help                      Show this help message

Typical workflow:
  1. Run \`hanzi-browser start "task"\`
  2. If needed, inspect progress with \`status\`, \`logs\`, or \`screenshot\`
  3. Continue the same session with \`message <session_id> "next step"\`
  4. Stop it with \`stop <session_id>\`

Use Hanzi when the task needs a real browser:
  - Logged-in sites: Jira, LinkedIn, Slack, GitHub, dashboards
  - UI testing and visual verification
  - Form filling in third-party web apps
  - Dynamic pages and infinite scroll

Prefer other tools first for:
  - Code inspection, git history, logs
  - APIs, SDKs, CLI commands, or other MCPs
  - Public/static pages you can fetch directly
  - Local files, env vars, structured data

Examples:
  hanzi-browser start "Search LinkedIn for immigration consultants in Toronto and collect 10 names" --url https://www.linkedin.com
  hanzi-browser start "Check flight prices to Tokyo" --url https://flights.google.com
  hanzi-browser status abc123
  hanzi-browser logs abc123 --follow
  hanzi-browser message abc123 "Click the first result and summarize the page"
  hanzi-browser screenshot abc123
  hanzi-browser stop abc123 --remove

Skills:
  Pre-built workflows for common tasks (LinkedIn prospecting, etc.).
  Run \`hanzi-browser skills\` to see what's available, or install one:
  \`hanzi-browser skills install linkedin-prospector\`
`);
}

// --- Main ---

export async function main(): Promise<void> {
  const invokedAs = process.argv[1] ? process.argv[1].split('/').pop() : '';
  if (invokedAs === 'hanzi-browser') {
    console.error('\x1b[33m[deprecation]\x1b[0m `hanzi-browser` is deprecated. Use `hanzi-browse` instead. Will be removed in v2.5.');
  }
  switch (command) {
    case 'start': await cmdStart(); break;
    case 'status': cmdStatus(); break;
    case 'message': await cmdMessage(); break;
    case 'logs': cmdLogs(); break;
    case 'stop': await cmdStop(); break;
    case 'screenshot': await cmdScreenshot(); break;
    case 'skills': await cmdSkills(); break;
    case 'setup': await cmdSetup(); break;
    case 'doctor': await cmdDoctor(); break;
    case 'version': case '--version': case '-v': cmdVersion(); break;
    case 'help': case '--help': case '-h': case undefined: cmdHelp(); break;
    default:
      console.error(`Unknown command: ${command}`);
      cmdHelp();
      process.exit(EXIT_CLI_ERROR);
  }
}

// Auto-run only when executed directly — NOT when imported from index.ts.
// When imported (via the hanzi-browse subcommand dispatch), index.ts calls main()
// explicitly and awaits it, so premature process.exit doesn't kill async commands.
const isEntryPoint =
  process.argv[1] &&
  (process.argv[1].endsWith('/cli.js') || process.argv[1].endsWith('hanzi-browser'));

if (isEntryPoint) {
  main().catch((err) => {
    console.error('[CLI] Error:', err);
    process.exit(EXIT_CLI_ERROR);
  });
}
