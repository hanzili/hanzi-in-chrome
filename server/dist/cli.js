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
import { existsSync, readFileSync, mkdirSync, watch, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { WebSocketClient } from './ipc/websocket-client.js';
import { writeSessionStatus, readSessionStatus, appendSessionLog, listSessions, deleteSessionFiles, getSessionLogPath, getSessionScreenshotPath, } from './cli/session-files.js';
// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];
let connection;
// Track completion for blocking start
let pendingResolve = null;
let activeSessionId = null;
let pendingScreenshotResolve = null;
async function initConnection() {
    if (connection?.isConnected())
        return;
    connection = new WebSocketClient({
        role: 'cli',
        autoStartRelay: true,
        onDisconnect: () => console.error('[CLI] Relay connection lost, will reconnect'),
    });
    connection.onMessage(handleMessage);
    await connection.connect();
    console.error('[CLI] Connected to WebSocket relay');
}
function handleMessage(message) {
    const { type, sessionId, ...data } = message;
    if (!sessionId)
        return;
    // Only process events for the session this CLI instance started.
    // Without this, all relay-connected CLI processes would write
    // logs/status for every session, causing duplicates.
    if (!activeSessionId || sessionId !== activeSessionId)
        return;
    const step = data.step || data.status || data.message;
    switch (type) {
        case 'task_update':
            if (step && step !== 'thinking' && !step.startsWith('[thinking]')) {
                appendSessionLog(sessionId, step);
                writeSessionStatus(sessionId, { status: 'running' });
                console.log(`  ${step.slice(0, 100)}`);
            }
            break;
        case 'task_complete': {
            const raw = step || data.result || 'Task completed';
            const answer = typeof raw === 'object' ? JSON.stringify(raw, null, 2) : String(raw);
            appendSessionLog(sessionId, `[COMPLETE] ${answer}`);
            writeSessionStatus(sessionId, { status: 'complete', result: answer });
            console.log(`\n[CLI] Task completed: ${sessionId}`);
            console.log(answer);
            pendingResolve?.();
            break;
        }
        case 'task_error':
            appendSessionLog(sessionId, `[ERROR] ${data.error}`);
            writeSessionStatus(sessionId, { status: 'error', error: data.error });
            console.error(`\n[CLI] Task error: ${data.error}`);
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
async function waitForTaskCompletion(timeoutMs = 5 * 60 * 1000) {
    await new Promise((resolve) => {
        pendingResolve = resolve;
        setTimeout(() => {
            console.error(`\n[CLI] Task timed out after ${Math.round(timeoutMs / 60000)} minutes`);
            resolve();
        }, timeoutMs);
    });
}
function disconnectAndExit(code = 0) {
    connection?.disconnect();
    setTimeout(() => process.exit(code), 100);
}
// --- Commands ---
async function cmdStart() {
    const task = args[1];
    if (!task) {
        console.error('Usage: hanzi-browser start "task description" [--url URL] [--context TEXT]');
        process.exit(1);
    }
    let url;
    let context;
    for (let i = 2; i < args.length; i++) {
        if (args[i] === '--url' || args[i] === '-u')
            url = args[++i];
        else if (args[i] === '--context' || args[i] === '-c')
            context = args[++i];
    }
    console.log('[CLI] Starting browser task...');
    console.log(`  Task: ${task}`);
    if (url)
        console.log(`  URL: ${url}`);
    if (context)
        console.log(`  Context: ${context.substring(0, 50)}...`);
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
    console.log(`\n[CLI] Session: ${sessionId}`);
    console.log(`  Status: ~/.hanzi-in-chrome/sessions/${sessionId}.json`);
    console.log(`  Logs:   ~/.hanzi-in-chrome/sessions/${sessionId}.log`);
    console.log(`  Skills: run \`hanzi-browser skills\` for optimized workflows (e.g. LinkedIn prospecting)`);
    console.log('\nWaiting for completion...\n');
    // Block until task completes
    await waitForTaskCompletion();
    disconnectAndExit(0);
}
function cmdStatus() {
    const sessionId = args[1];
    if (sessionId) {
        const status = readSessionStatus(sessionId);
        if (!status) {
            console.error(`Session not found: ${sessionId}`);
            process.exit(1);
        }
        console.log(JSON.stringify(status, null, 2));
    }
    else {
        const allSessions = listSessions();
        if (allSessions.length === 0) {
            console.log('No sessions found.');
        }
        else {
            console.log(`Found ${allSessions.length} session(s):\n`);
            for (const s of allSessions) {
                const taskPreview = s.task ? s.task.substring(0, 55) : '(no task)';
                console.log(`  ${s.session_id.padEnd(10)} ${s.status.padEnd(10)} ${taskPreview}`);
            }
        }
    }
}
async function cmdMessage() {
    const sessionId = args[1];
    const message = args[2];
    if (!sessionId || !message) {
        console.error('Usage: hanzi-browser message <session_id> "message"');
        process.exit(1);
    }
    activeSessionId = sessionId;
    await initConnection();
    await connection.send({ type: 'mcp_send_message', sessionId, message });
    appendSessionLog(sessionId, `[USER] ${message}`);
    console.log(`Message sent to session ${sessionId}`);
    console.log('Waiting for completion...\n');
    await waitForTaskCompletion();
    disconnectAndExit(0);
}
function cmdLogs() {
    const sessionId = args[1];
    const follow = args.includes('--follow') || args.includes('-f');
    if (!sessionId) {
        console.error('Usage: hanzi-browser logs <session_id> [--follow]');
        process.exit(1);
    }
    const logPath = getSessionLogPath(sessionId);
    if (!existsSync(logPath)) {
        console.error(`Log file not found: ${logPath}`);
        process.exit(1);
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
async function cmdStop() {
    const sessionId = args[1];
    const remove = args.includes('--remove') || args.includes('-r');
    if (!sessionId) {
        console.error('Usage: hanzi-browser stop <session_id> [--remove]');
        process.exit(1);
    }
    activeSessionId = sessionId;
    await initConnection();
    await connection.send({ type: 'mcp_stop_task', sessionId, remove });
    if (remove) {
        deleteSessionFiles(sessionId);
        console.log(`Session ${sessionId} stopped and removed.`);
    }
    else {
        writeSessionStatus(sessionId, { status: 'stopped' });
        console.log(`Session ${sessionId} stopped.`);
    }
    disconnectAndExit(0);
}
async function cmdScreenshot() {
    const sessionId = args[1];
    const requestId = sessionId || `screenshot-${Date.now()}`;
    activeSessionId = requestId;
    await initConnection();
    await connection.send({ type: 'mcp_screenshot', sessionId: requestId });
    console.log(`Screenshot requested for ${requestId}. Waiting for image...\n`);
    const data = await new Promise((resolve) => {
        pendingScreenshotResolve = resolve;
        setTimeout(() => {
            pendingScreenshotResolve = null;
            resolve(null);
        }, 10000);
    });
    if (!data) {
        console.error('[CLI] Screenshot timed out');
        disconnectAndExit(1);
        return;
    }
    const screenshotPath = getSessionScreenshotPath(requestId);
    writeFileSync(screenshotPath, Buffer.from(data, 'base64'));
    console.log(`[CLI] Screenshot saved: ${screenshotPath}`);
    disconnectAndExit(0);
}
// --- Skills ---
const SKILLS_BASE_URL = 'https://raw.githubusercontent.com/hanzili/llm-in-chrome/main/server/skills';
const SKILL_REGISTRY = [
    {
        name: 'linkedin-prospector',
        description: 'Find people on LinkedIn and send personalized connection requests',
        files: ['SKILL.md'],
    },
    {
        name: 'e2e-tester',
        description: 'Test your web app in a real browser — reports bugs with code references',
        files: ['SKILL.md'],
    },
    {
        name: 'social-poster',
        description: 'Post across LinkedIn, Twitter, Reddit, HN — drafts per-platform, posts from your browser',
        files: ['SKILL.md'],
    },
];
async function cmdSkills() {
    const subcommand = args[1];
    if (subcommand === 'install') {
        const skillName = args[2];
        if (!skillName) {
            console.error('Usage: hanzi-browser skills install <name>');
            process.exit(1);
        }
        const skill = SKILL_REGISTRY.find(s => s.name === skillName);
        if (!skill) {
            console.error(`Unknown skill: ${skillName}`);
            console.error(`Available: ${SKILL_REGISTRY.map(s => s.name).join(', ')}`);
            process.exit(1);
        }
        // Detect the right directory
        const targetDir = detectSkillsDir(skillName);
        mkdirSync(targetDir, { recursive: true });
        console.log(`Installing ${skillName}...`);
        for (const file of skill.files) {
            const url = `${SKILLS_BASE_URL}/${skillName}/${file}`;
            try {
                const response = await fetch(url);
                if (!response.ok)
                    throw new Error(`HTTP ${response.status}`);
                const content = await response.text();
                const filePath = join(targetDir, file);
                writeFileSync(filePath, content);
                console.log(`  → ${filePath}`);
            }
            catch (err) {
                console.error(`  Failed to download ${file}: ${err.message}`);
                process.exit(1);
            }
        }
        console.log(`\nDone! "${skillName}" is ready to use.`);
        return;
    }
    // Default: list available skills
    console.log('\nAvailable skills:\n');
    for (const skill of SKILL_REGISTRY) {
        console.log(`  ${skill.name.padEnd(24)} ${skill.description}`);
    }
    console.log(`\nInstall: hanzi-browser skills install <name>`);
    console.log(`Browse:  https://browse.hanzilla.co/skills\n`);
}
function detectSkillsDir(skillName) {
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
async function cmdSetup() {
    const { runSetup } = await import('./cli/setup.js');
    let only;
    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--only' && args[i + 1])
            only = args[++i];
    }
    await runSetup({ only });
}
function cmdHelp() {
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
                            Blocks until complete or timeout.
                            You can run multiple start commands in parallel.
                            Each session gets its own browser window.

  status [session_id]       Show status of session(s)

  message <session_id> <msg>  Send follow-up instructions to a session
                              Reuses the same browser window and page state.

  logs <session_id>         Show logs for a session
    --follow, -f            Watch logs in real-time

  stop <session_id>         Stop a session
    --remove, -r            Also delete session files

  screenshot [session_id]   Take a screenshot

  setup                     Auto-detect AI agents and configure MCP
    --only <agent>          Only configure one agent (claude-code, cursor, windsurf, claude-desktop)

  skills                    List available agent skills
  skills install <name>     Download a skill into your project

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
async function main() {
    switch (command) {
        case 'start':
            await cmdStart();
            break;
        case 'status':
            cmdStatus();
            break;
        case 'message':
            await cmdMessage();
            break;
        case 'logs':
            cmdLogs();
            break;
        case 'stop':
            await cmdStop();
            break;
        case 'screenshot':
            await cmdScreenshot();
            break;
        case 'skills':
            await cmdSkills();
            break;
        case 'setup':
            await cmdSetup();
            break;
        case 'help':
        case '--help':
        case '-h':
        case undefined:
            cmdHelp();
            break;
        default:
            console.error(`Unknown command: ${command}`);
            cmdHelp();
            process.exit(1);
    }
}
main().catch((err) => {
    console.error('[CLI] Error:', err);
    process.exit(1);
});
