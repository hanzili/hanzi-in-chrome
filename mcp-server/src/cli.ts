#!/usr/bin/env node

/**
 * LLM Browser CLI
 *
 * Command-line interface for browser automation.
 * Sends tasks to the Chrome extension via WebSocket relay.
 *
 * Usage:
 *   llm-browser start "task" --url https://example.com
 *   llm-browser status [session_id]
 *   llm-browser message <session_id> "message"
 *   llm-browser logs <session_id> [--follow]
 *   llm-browser stop <session_id> [--remove]
 *   llm-browser screenshot <session_id>
 */

import { existsSync, readFileSync, watch } from 'fs';
import { randomUUID } from 'crypto';

import { WebSocketClient } from './ipc/websocket-client.js';
import {
  writeSessionStatus,
  readSessionStatus,
  appendSessionLog,
  listSessions,
  deleteSessionFiles,
  getSessionLogPath,
  type SessionFileStatus,
} from './cli/session-files.js';

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0];

let connection: WebSocketClient;

// Track completion for blocking start
let pendingResolve: (() => void) | null = null;
let activeSessionId: string | null = null;

async function initConnection(): Promise<void> {
  if (connection?.isConnected()) return;

  connection = new WebSocketClient({
    role: 'cli',
    autoStartRelay: true,
    onDisconnect: () => console.error('[CLI] Relay connection lost, will reconnect'),
  });

  connection.onMessage(handleMessage);
  await connection.connect();
  console.error('[CLI] Connected to WebSocket relay');
}

function handleMessage(message: any): void {
  const { type, sessionId, ...data } = message;
  if (!sessionId) return;

  // Only process events for the session this CLI instance started.
  // Without this, all relay-connected CLI processes would write
  // logs/status for every session, causing duplicates.
  if (activeSessionId && sessionId !== activeSessionId) return;

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
  }
}

// --- Commands ---

async function cmdStart(): Promise<void> {
  const task = args[1];
  if (!task) {
    console.error('Usage: llm-browser start "task description" [--url URL] [--context TEXT]');
    process.exit(1);
  }

  let url: string | undefined;
  let context: string | undefined;

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--url' || args[i] === '-u') url = args[++i];
    else if (args[i] === '--context' || args[i] === '-c') context = args[++i];
  }

  console.log('[CLI] Starting browser task...');
  console.log(`  Task: ${task}`);
  if (url) console.log(`  URL: ${url}`);
  if (context) console.log(`  Context: ${context.substring(0, 50)}...`);

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
  console.log('\nWaiting for completion...\n');

  // Block until task completes
  await new Promise<void>((resolve) => {
    pendingResolve = resolve;
    // Safety timeout
    setTimeout(() => {
      console.error('\n[CLI] Task timed out after 5 minutes');
      resolve();
    }, 5 * 60 * 1000);
  });

  setTimeout(() => process.exit(0), 500);
}

function cmdStatus(): void {
  const sessionId = args[1];

  if (sessionId) {
    const status = readSessionStatus(sessionId);
    if (!status) {
      console.error(`Session not found: ${sessionId}`);
      process.exit(1);
    }
    console.log(JSON.stringify(status, null, 2));
  } else {
    const allSessions = listSessions();
    if (allSessions.length === 0) {
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

  if (!sessionId || !message) {
    console.error('Usage: llm-browser message <session_id> "message"');
    process.exit(1);
  }

  await initConnection();
  await connection.send({ type: 'mcp_send_message', sessionId, message });
  appendSessionLog(sessionId, `[USER] ${message}`);
  console.log(`Message sent to session ${sessionId}`);
}

function cmdLogs(): void {
  const sessionId = args[1];
  const follow = args.includes('--follow') || args.includes('-f');

  if (!sessionId) {
    console.error('Usage: llm-browser logs <session_id> [--follow]');
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

async function cmdStop(): Promise<void> {
  const sessionId = args[1];
  const remove = args.includes('--remove') || args.includes('-r');

  if (!sessionId) {
    console.error('Usage: llm-browser stop <session_id> [--remove]');
    process.exit(1);
  }

  await initConnection();
  await connection.send({ type: 'mcp_stop_task', sessionId, remove });

  if (remove) {
    deleteSessionFiles(sessionId);
    console.log(`Session ${sessionId} stopped and removed.`);
  } else {
    writeSessionStatus(sessionId, { status: 'stopped' });
    console.log(`Session ${sessionId} stopped.`);
  }
}

async function cmdScreenshot(): Promise<void> {
  const sessionId = args[1];
  await initConnection();
  await connection.send({ type: 'mcp_screenshot', sessionId: sessionId || `screenshot-${Date.now()}` });
  console.log('Screenshot requested. Check the browser extension.');
}

function cmdHelp(): void {
  console.log(`
LLM Browser CLI - Browser automation from the command line

Usage:
  llm-browser <command> [options]

Commands:
  start <task>              Start a new browser task
    --url, -u <url>         Starting URL
    --context, -c <text>    Context information for the task

  status [session_id]       Show status of session(s)

  message <session_id> <msg>  Send a follow-up message to a session

  logs <session_id>         Show logs for a session
    --follow, -f            Watch logs in real-time

  stop <session_id>         Stop a session
    --remove, -r            Also delete session files

  screenshot [session_id]   Take a screenshot

  help                      Show this help message

Examples:
  llm-browser start "Search for AI news" --url https://google.com
  llm-browser status abc123
  llm-browser logs abc123 --follow
  llm-browser message abc123 "Click the first result"
  llm-browser stop abc123 --remove
`);
}

// --- Main ---

async function main(): Promise<void> {
  switch (command) {
    case 'start': await cmdStart(); break;
    case 'status': cmdStatus(); break;
    case 'message': await cmdMessage(); break;
    case 'logs': cmdLogs(); break;
    case 'stop': await cmdStop(); break;
    case 'screenshot': await cmdScreenshot(); break;
    case 'help': case '--help': case '-h': case undefined: cmdHelp(); break;
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
