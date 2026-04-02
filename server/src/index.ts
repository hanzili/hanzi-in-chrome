#!/usr/bin/env node

// If invoked as `npx hanzi-browse setup`, delegate to the CLI
if (process.argv[2] === 'setup') {
  const { fileURLToPath } = await import('url');
  const { dirname, join } = await import('path');
  const { execFileSync } = await import('child_process');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const cliPath = join(__dirname, 'cli.js');
  try {
    execFileSync(process.execPath, [cliPath, ...process.argv.slice(2)], { stdio: 'inherit' });
  } catch { /* exit code propagated */ }
  process.exit(0);
}

// If invoked as `npx hanzi-browse telemetry [on|off]`, handle inline
if (process.argv[2] === 'telemetry') {
  const { isTelemetryEnabled, setTelemetryEnabled } = await import('./telemetry.js');
  const sub = process.argv[3];
  if (sub === 'on') {
    setTelemetryEnabled(true);
    console.log('Telemetry enabled. Anonymous usage stats help improve Hanzi.');
  } else if (sub === 'off') {
    setTelemetryEnabled(false);
    console.log('Telemetry disabled. No data will be collected.');
  } else {
    console.log(`Telemetry is ${isTelemetryEnabled() ? 'enabled' : 'disabled'}.`);
    console.log('Usage: hanzi-browse telemetry [on|off]');
  }
  process.exit(0);
}

import { initTelemetry, trackEvent, captureException, shutdownTelemetry } from "./telemetry.js";

initTelemetry();
trackEvent("mcp_start");

/**
 * Hanzi Browse MCP Server
 *
 * MCP transport + session wrapper for the extension-side browser agent.
 * The Chrome extension owns browser execution; this server forwards tasks,
 * tracks session metadata, and waits for completion events.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, PROMPTS, PROMPT_TEMPLATES } from "./mcp/tools.js";
import { WebSocketClient } from "./ipc/websocket-client.js";
import type { NativeMessage } from "./ipc/index.js";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { describeCredentials, resolveCredentials } from "./llm/credentials.js";
import { callLLM } from "./llm/client.js";
import { checkAndIncrementUsage, getLicenseStatus } from "./license/manager.js";

// --- Managed proxy mode ---
// When HANZI_API_KEY is set, tasks are proxied to the managed API instead of
// running locally. This lets users without their own LLM key use Hanzi managed.
const MANAGED_API_KEY = process.env.HANZI_API_KEY;
const MANAGED_API_URL = process.env.HANZI_API_URL || "https://api.hanzilla.co";
const IS_MANAGED_MODE = !!MANAGED_API_KEY;

async function managedApiCall(method: string, path: string, body?: any): Promise<any> {
  const res = await fetch(`${MANAGED_API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MANAGED_API_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function runManagedTask(task: string, url?: string, context?: string): Promise<{ status: string; answer: string; steps: number; error?: string }> {
  // Find a connected browser session
  const sessionsRes = await managedApiCall("GET", "/v1/browser-sessions");
  const connected = sessionsRes?.sessions?.find((s: any) => s.status === "connected");
  if (!connected) {
    return { status: "error", answer: "No browser connected. Open Chrome with the Hanzi extension and pair it first.", steps: 0 };
  }

  // Create task
  const created = await managedApiCall("POST", "/v1/tasks", {
    task, url, context, browser_session_id: connected.id,
  });
  if (created.error) return { status: "error", answer: created.error, steps: 0 };

  // Poll until done (max 5 min)
  const taskId = created.id;
  const deadline = Date.now() + TASK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const status = await managedApiCall("GET", `/v1/tasks/${taskId}`);
    if (status.status !== "running") {
      return {
        status: status.status,
        answer: status.answer || "No answer.",
        steps: status.steps || 0,
        error: status.error,
      };
    }
  }
  return { status: "timeout", answer: "Task still running. Check back later.", steps: 0 };
}

// --- Session tracking ---

interface Session {
  id: string;
  task: string;
  url?: string;
  context?: string;
  status: "running" | "complete" | "error" | "stopped" | "waiting" | "timeout";
  steps: string[];
  answer?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const sessions = new Map<string, Session>();

// Pending screenshot requests
interface PendingScreenshot {
  resolve: (data: string | null) => void;
  timeout: NodeJS.Timeout;
}
const pendingScreenshots = new Map<string, PendingScreenshot>();

// Max time a task can run before we return (configurable, default 5 minutes)
const TASK_TIMEOUT_MS = parseInt(process.env.HANZI_BROWSE_TIMEOUT_MS || String(5 * 60 * 1000), 10);
const MAX_CONCURRENT = parseInt(process.env.HANZI_BROWSE_MAX_SESSIONS || "5", 10);
const SESSION_TTL_MS = parseInt(process.env.HANZI_BROWSE_SESSION_TTL_MS || String(60 * 60 * 1000), 10);

// WebSocket relay connection
let connection: WebSocketClient;

// --- Message waiting infrastructure ---

type MessageFilter = (msg: any) => boolean;
interface PendingWaiter {
  filter: MessageFilter;
  resolve: (msg: any) => void;
  timeout: NodeJS.Timeout;
}
const pendingWaiters: PendingWaiter[] = [];

/**
 * Wait for a specific message from the extension via WebSocket relay.
 * Returns null on timeout.
 */
function waitForRelayMessage(
  filter: MessageFilter,
  timeoutMs: number = 60000
): Promise<any> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      const idx = pendingWaiters.findIndex((w) => w.resolve === resolve);
      if (idx !== -1) pendingWaiters.splice(idx, 1);
      resolve(null);
    }, timeoutMs);

    pendingWaiters.push({ filter, resolve, timeout });
  });
}

/**
 * Route incoming relay messages to pending waiters.
 */
async function handleMessage(message: any): Promise<void> {
  if (message?.type === "mcp_get_info") {
    void handleGetInfoRequest(message);
    return;
  }

  if (message?.type === "mcp_escalate") {
    void handleEscalationRequest(message);
    return;
  }

  updateSessionFromMessage(message);

  // Check pending waiters first
  for (let i = 0; i < pendingWaiters.length; i++) {
    const waiter = pendingWaiters[i];
    if (waiter.filter(message)) {
      clearTimeout(waiter.timeout);
      pendingWaiters.splice(i, 1);
      waiter.resolve(message);
      return;
    }
  }

  // Handle screenshots for pending requests
  const { type, sessionId, ...data } = message;
  if (type === "screenshot" && data.data && sessionId) {
    const pending = pendingScreenshots.get(sessionId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(data.data);
      pendingScreenshots.delete(sessionId);
    }
  }
}

async function send(message: NativeMessage): Promise<void> {
  await connection.send(message);
}

async function callTextModel(systemText: string, userText: string, maxTokens = 700): Promise<string> {
  const response = await callLLM({
    messages: [{ role: "user", content: userText }],
    system: [{ type: "text", text: systemText }],
    tools: [],
    maxTokens,
  });

  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!text) {
    throw new Error("LLM returned no text content");
  }

  return text;
}

async function handleGetInfoRequest(message: any): Promise<void> {
  const { sessionId, query, requestId } = message;
  if (!requestId) return;

  const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
  const context = session?.context?.trim();

  let responseText: string;
  if (!context) {
    responseText = `Information not found: no task context was provided for this session.`;
  } else {
    try {
      responseText = await callTextModel(
        "Answer the user's query using only the provided task context. If the context does not contain the answer, reply exactly with 'Information not found.' Do not invent facts.",
        `Task context:\n${context}\n\nQuery:\n${query}`,
        500,
      );
    } catch (error: any) {
      responseText = `Information lookup failed: ${error.message}. Raw task context:\n${context}`;
    }
  }

  await send({
    type: "mcp_get_info_response",
    sessionId,
    requestId,
    response: responseText,
  } as any);
}

async function handleEscalationRequest(message: any): Promise<void> {
  const { sessionId, requestId, problem, whatITried, whatINeed } = message;
  if (!requestId) return;

  const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
  const taskSummary = session
    ? `Task: ${session.task}\nContext: ${session.context || "(none)"}\nRecent steps:\n${session.steps.slice(-8).join("\n") || "(none)"}`
    : "Task/session state unavailable.";

  let responseText: string;
  try {
    responseText = await callTextModel(
      "You are a planning assistant helping a browser automation agent recover from a blocker. Give short, concrete next-step guidance. Prefer actions the browser agent can try immediately. If user input is required, say exactly what is missing.",
      `Session state:\n${taskSummary}\n\nProblem:\n${problem}\n\nWhat I tried:\n${whatITried || "(not provided)"}\n\nWhat I need:\n${whatINeed || "(not provided)"}`,
      600,
    );
  } catch (error: any) {
    responseText = `Escalation handling failed: ${error.message}. Try a smaller step, re-read the page, or request the missing information explicitly.`;
  }

  await send({
    type: "mcp_escalate_response",
    sessionId,
    requestId,
    response: responseText,
  } as any);
}

function extractAnswer(result: unknown): string | undefined {
  if (result == null) return undefined;
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const maybeMessage = (result as Record<string, unknown>).message;
    if (typeof maybeMessage === "string") return maybeMessage;
    return JSON.stringify(result);
  }
  return String(result);
}

function updateSessionFromMessage(message: any): void {
  const sessionId = message?.sessionId;
  if (!sessionId) return;

  const session = sessions.get(sessionId);
  if (!session) return;

  session.updatedAt = Date.now();

  switch (message.type) {
    case "task_update":
      session.status = message.status === "running" ? "running" : session.status;
      if (typeof message.step === "string" && message.step.trim()) {
        const lastStep = session.steps[session.steps.length - 1];
        if (lastStep !== message.step) {
          session.steps.push(message.step);
        }
      }
      break;

    case "task_complete":
      session.status = "complete";
      session.answer = extractAnswer(message.result);
      session.error = undefined;
      break;

    case "task_error":
      session.status = "error";
      session.answer = undefined;
      session.error = typeof message.error === "string" ? message.error : "Task failed";
      break;
  }
}

function formatResult(session: Session): any {
  const result: any = {
    session_id: session.id,
    status: session.status,
    task: session.task,
  };
  if (session.answer) result.answer = session.answer;
  if (session.error) result.error = session.error;
  if (session.steps.length > 0) {
    result.total_steps = session.steps.length;
    result.recent_steps = session.steps.slice(-5);
  }
  return result;
}

function waitForSessionTerminal(sessionId: string, timeoutMs: number = TASK_TIMEOUT_MS): Promise<any> {
  return waitForRelayMessage(
    (msg) =>
      msg.sessionId === sessionId &&
      (msg.type === "task_complete" || msg.type === "task_error"),
    timeoutMs
  );
}

// --- Helpers ---

const EXTENSION_URL = "https://chromewebstore.google.com/detail/hanzi-browse/iklpkemlmbhemkiojndpbhoakgikpmcd";

function openInBrowser(url: string): void {
  const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${cmd} "${url}"`);
}

// --- Extension connectivity check ---

function checkExtensionOnce(): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = `status-${Date.now()}-${randomUUID().slice(0, 4)}`;
    const timeout = setTimeout(() => {
      connection.offMessage(handler);
      resolve(false);
    }, 2000);
    const handler = (msg: any) => {
      if (msg.type === "status_response" && msg.requestId === requestId) {
        clearTimeout(timeout);
        connection.offMessage(handler);
        resolve(msg.extensionConnected === true);
      }
    };
    connection.onMessage(handler);
    connection.send({ type: "status_query", requestId } as any).catch(() => resolve(false));
  });
}

async function isExtensionConnected(): Promise<boolean> {
  // Chrome suspends MV3 service workers after ~30s of inactivity, dropping the
  // WebSocket. The relay pings the extension every 20s to prevent this, but if
  // the connection was already lost, wait for the keepalive alarm to reconnect.
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 3000;
  for (let i = 0; i < MAX_RETRIES; i++) {
    if (await checkExtensionOnce()) return true;
    if (i === 0) {
      console.error("[MCP] Extension not connected, waiting for service worker to wake up...");
    }
    if (i < MAX_RETRIES - 1) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (session.status === "running") continue;
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

// --- MCP Server ---

const server = new Server(
  { name: "browser-automation", version: "2.0.0" },
  { capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// --- Prompts ---

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const template = PROMPT_TEMPLATES[name];
  if (!template) {
    throw new Error(`Unknown prompt: ${name}`);
  }
  return template(args || {});
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "browser_start": {
        const task = args?.task as string;
        const url = args?.url as string | undefined;
        const context = args?.context as string | undefined;

        if (!task?.trim()) {
          return { content: [{ type: "text", text: "Error: task cannot be empty" }], isError: true };
        }

        // --- Managed proxy mode: forward to api.hanzilla.co ---
        if (IS_MANAGED_MODE) {
          console.error(`[MCP] Managed mode — proxying task to ${MANAGED_API_URL}`);
          const result = await runManagedTask(task, url, context);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            isError: result.status === "error",
          };
        }

        // --- Local BYOM mode ---

        // Check license / usage limit
        const usage = await checkAndIncrementUsage();
        if (!usage.allowed) {
          return { content: [{ type: "text", text: usage.message }], isError: true };
        }
        console.error(`[MCP] ${usage.message}`);

        // Check credentials before starting
        const creds = resolveCredentials();
        if (!creds) {
          return {
            content: [{
              type: "text",
              text: "No LLM credentials found. Set ANTHROPIC_API_KEY env var or run `claude login`.",
            }],
            isError: true,
          };
        }

        // Pre-flight: check if extension is connected
        if (!await isExtensionConnected()) {
          openInBrowser(EXTENSION_URL);
          return {
            content: [{
              type: "text",
              text: `Chrome extension is not connected. Opening install page in your browser.\n\nIf already installed, make sure Chrome is open and the extension is enabled. Then try again.`,
            }],
            isError: true,
          };
        }

        // Check concurrency
        const activeCount = [...sessions.values()].filter((s) => s.status === "running").length;
        if (activeCount >= MAX_CONCURRENT) {
          return {
            content: [{
              type: "text",
              text: `Too many parallel tasks (${activeCount}/${MAX_CONCURRENT}). Wait for some to complete or stop them first.`,
            }],
            isError: true,
          };
        }

        const session: Session = {
          id: randomUUID().slice(0, 8),
          task,
          url,
          context,
          status: "running",
          steps: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        sessions.set(session.id, session);

        console.error(`[MCP] Starting task ${session.id}: ${task.slice(0, 80)}`);

        const completionPromise = waitForSessionTerminal(session.id);
        await send({
          type: "mcp_start_task",
          sessionId: session.id,
          task,
          url,
          context,
        } as any);

        const result = await completionPromise;
        if (result === null) {
          session.status = "timeout";
          session.error = `Task still running after ${TASK_TIMEOUT_MS / 60000} minutes. Use browser_screenshot to check progress, then browser_message to continue or browser_stop to end.`;
        }

        if (session.status === "complete") {
          trackEvent("task_completed", {
            steps: session.steps.length,
            duration_ms: Date.now() - session.createdAt,
          });
        } else {
          trackEvent("task_failed", {
            error_category: session.status === "timeout" ? "timeout" : "unknown",
            steps: session.steps.length,
          });
        }

        return {
          content: [{ type: "text", text: JSON.stringify(formatResult(session), null, 2) }],
          isError: session.status === "error",
        };
      }

      case "browser_message": {
        const sessionId = args?.session_id as string;
        const message = args?.message as string;
        const session = sessions.get(sessionId);

        if (!session) {
          return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
        }
        if (!message?.trim()) {
          return { content: [{ type: "text", text: "Error: message cannot be empty" }], isError: true };
        }

        session.status = "running";
        session.answer = undefined;
        session.error = undefined;
        session.updatedAt = Date.now();

        console.error(`[MCP] Message to ${sessionId}: ${message.slice(0, 80)}`);

        const completionPromise = waitForSessionTerminal(session.id);
        await send({
          type: "mcp_send_message",
          sessionId: session.id,
          message,
        } as any);

        const result = await completionPromise;
        if (result === null) {
          session.status = "timeout";
          session.error = `Task still running after ${TASK_TIMEOUT_MS / 60000} minutes.`;
        }

        const latestSession = sessions.get(session.id) || session;
        return {
          content: [{ type: "text", text: JSON.stringify(formatResult(latestSession), null, 2) }],
          isError: latestSession.status === "error",
        };
      }

      case "browser_status": {
        const sessionId = args?.session_id as string | undefined;

        if (sessionId) {
          const session = sessions.get(sessionId);
          if (!session) {
            return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
          }
          return { content: [{ type: "text", text: JSON.stringify(formatResult(session), null, 2) }] };
        }

        const all = [...sessions.values()].map(formatResult);
        return { content: [{ type: "text", text: JSON.stringify(all, null, 2) }] };
      }

      case "browser_stop": {
        const sessionId = args?.session_id as string;
        const session = sessions.get(sessionId);

        if (!session) {
          return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
        }

        await send({ type: "mcp_stop_task", sessionId, remove: args?.remove === true } as any);

        if (args?.remove) {
          sessions.delete(sessionId);
          return { content: [{ type: "text", text: `Session ${sessionId} removed.` }] };
        }

        session.status = "stopped";
        return { content: [{ type: "text", text: `Session ${sessionId} stopped.` }] };
      }

      case "browser_screenshot": {
        const sessionId = args?.session_id as string | undefined;
        const requestId = sessionId || `screenshot-${Date.now()}`;

        const screenshotPromise = new Promise<string | null>((resolve) => {
          const timeout = setTimeout(() => {
            pendingScreenshots.delete(requestId);
            resolve(null);
          }, 5000);
          pendingScreenshots.set(requestId, { resolve, timeout });
        });

        await send({ type: "mcp_screenshot", sessionId: requestId } as any);
        const data = await screenshotPromise;

        if (data) {
          return {
            content: [
              { type: "image", data, mimeType: "image/png" },
              { type: "text", text: "Screenshot of current browser state" },
            ],
          };
        }

        return { content: [{ type: "text", text: "Screenshot timed out." }], isError: true };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error: any) {
    captureException(error, { tool: name });
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});

// --- Startup ---

async function main() {
  console.error("[MCP] Starting Hanzi Browse MCP Server v2.0...");

  if (IS_MANAGED_MODE) {
    console.error(`[MCP] Mode: MANAGED (proxying tasks to ${MANAGED_API_URL})`);
    console.error(`[MCP] API key: ${MANAGED_API_KEY!.slice(0, 20)}...`);
  } else {
    console.error("[MCP] Mode: BYOM (local agent loop)");
    // Startup diagnostics
    const credDesc = describeCredentials();
    console.error(`[MCP] Credentials: ${credDesc}`);
    const licenseStatus = getLicenseStatus();
    console.error(`[MCP] License: ${licenseStatus.message}`);
  }

  connection = new WebSocketClient({
    role: "mcp",
    autoStartRelay: true,
    onDisconnect: () => console.error("[MCP] Relay disconnected, will reconnect"),
  });
  connection.onMessage(handleMessage);
  await connection.connect();
  console.error("[MCP] Connected to relay");

  // Quick extension check at startup (single probe, no retries — don't block startup)
  try {
    if (await checkExtensionOnce()) {
      console.error("[MCP] Extension connected — ready for tasks");
    } else {
      console.error("[MCP] Extension not connected — will retry when tasks arrive");
    }
  } catch {
    // Non-fatal — don't block startup
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Server running (browser execution: extension-side)");
}

process.on("beforeExit", async () => {
  await shutdownTelemetry();
});
process.on("SIGTERM", async () => { await shutdownTelemetry(); process.exit(0); });
process.on("SIGINT", async () => { await shutdownTelemetry(); process.exit(0); });

main().catch((error) => {
  captureException(error, { context: "fatal_startup" });
  console.error("[MCP] Fatal:", error);
  process.exit(1);
});
