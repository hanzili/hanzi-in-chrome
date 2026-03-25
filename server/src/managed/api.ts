/**
 * Managed API Server
 *
 * REST API for external clients to run browser tasks.
 * Enforces: API key auth, workspace ownership, browser session validation.
 *
 * Endpoints:
 *   POST   /v1/browser-sessions/pair     - Create a pairing token
 *   POST   /v1/browser-sessions/register - Exchange pairing token for session
 *   GET    /v1/browser-sessions          - List sessions for workspace
 *   POST   /v1/tasks                     - Start a task (requires browser_session_id)
 *   GET    /v1/tasks/:id                 - Get task status/result
 *   POST   /v1/tasks/:id/cancel          - Cancel a running task
 *   GET    /v1/tasks                     - List tasks for workspace
 *   GET    /v1/usage                     - Get usage summary
 *   POST   /v1/api-keys                  - Create an API key (self-serve)
 *   GET    /v1/api-keys                  - List API keys for workspace
 *   DELETE /v1/api-keys/:id              - Delete an API key
 *   GET    /v1/health                    - Health check (no auth)
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { log } from "./log.js";
import {
  runAgentLoop,
  type AgentLoopResult,
  type ToolResult,
} from "../agent/loop.js";
import type { WebSocketClient } from "../ipc/websocket-client.js";
import * as fileStore from "./store.js";
import type { ApiKey } from "./store.js";
import { createAuth, resolveSessionToWorkspace, resolveSessionProfile } from "./auth.js";
import { initBilling, isBillingEnabled, createCheckoutSession, handleWebhook, recordTaskUsage } from "./billing.js";
import { existsSync, readFileSync } from "fs";
import { join, extname } from "path";

// Active store module — defaults to file store, can be swapped to Postgres via setStoreModule()
let S: typeof fileStore = fileStore;

/**
 * Swap the backing store (e.g., to Postgres). Called by deploy.ts when DATABASE_URL is set.
 */
export function setStoreModule(storeModule: typeof fileStore): void {
  S = storeModule;
}

let isSessionConnectedFn: ((id: string) => boolean) | null = null;

// --- State ---

let relayConnection: WebSocketClient | null = null;
const taskAborts = new Map<string, AbortController>();
/** Maps taskRunId → { workspaceId, startedAt } for concurrent task counting + stuck detection */
const taskWorkspaceMap = new Map<string, { workspaceId: string; startedAt: number }>();
const pendingToolExec = new Map<
  string,
  {
    resolve: (result: ToolResult) => void;
    reject: (err: Error) => void;
    timeout: NodeJS.Timeout;
    browserSessionId: string;
    createdAt: number;
  }
>();

// --- Rate Limiting ---

/** Per-workspace rate limit: max task creations in a sliding window */
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_TASKS = 10;     // max 10 task creations per minute per workspace
const MAX_CONCURRENT_TASKS = 5;      // max 5 running tasks per workspace simultaneously

interface RateBucket {
  timestamps: number[];
}

const rateBuckets = new Map<string, RateBucket>();

function checkRateLimit(workspaceId: string): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(workspaceId);
  if (!bucket) {
    bucket = { timestamps: [] };
    rateBuckets.set(workspaceId, bucket);
  }
  // Purge old entries outside the window
  bucket.timestamps = bucket.timestamps.filter(
    (t) => now - t <= RATE_LIMIT_WINDOW_MS
  );
  if (bucket.timestamps.length >= RATE_LIMIT_MAX_TASKS) {
    return false; // Rate limit exceeded
  }
  bucket.timestamps.push(now);
  return true;
}

function countConcurrentTasks(workspaceId: string): number {
  let count = 0;
  for (const [, entry] of taskWorkspaceMap) {
    if (entry.workspaceId === workspaceId) count++;
  }
  return count;
}

// Periodic cleanup of stale rate limit buckets (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [id, bucket] of rateBuckets) {
    bucket.timestamps = bucket.timestamps.filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS
    );
    if (bucket.timestamps.length === 0) rateBuckets.delete(id);
  }
}, 5 * 60_000);

// Periodic cleanup of stale pendingToolExec entries (orphans from crashed tasks/disconnects)
const MAX_PENDING_AGE_MS = 2 * 35_000; // 2× max tool timeout (70s)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [requestId, pending] of pendingToolExec) {
    if (now - pending.createdAt > MAX_PENDING_AGE_MS) {
      clearTimeout(pending.timeout);
      pendingToolExec.delete(requestId);
      pending.reject(new Error(`Tool execution orphaned (cleanup sweep): ${requestId}`));
      cleaned++;
    }
  }
  if (cleaned > 0) {
    log.warn("Cleaned up orphaned pending tool executions", undefined, { count: cleaned });
  }
}, 30_000); // Run every 30s

// Stuck-task janitor: abort and mark tasks that have been running longer than the timeout.
// Catches: leaked abort controllers, updateTaskRun failures, agent loop hangs.
const STUCK_TASK_THRESHOLD_MS = 35 * 60 * 1000; // 35 minutes (TASK_TIMEOUT_MS=30m + 5m buffer)
setInterval(async () => {
  try {
    const now = Date.now();
    for (const [taskId, entry] of taskWorkspaceMap) {
      if (now - entry.startedAt > STUCK_TASK_THRESHOLD_MS) {
        // Task has been running too long — abort and mark as error
        const abort = taskAborts.get(taskId);
        if (abort) abort.abort();
        try {
          await S.updateTaskRun(taskId, {
            status: "error",
            answer: "Task exceeded maximum duration (janitor cleanup).",
            completedAt: now,
          });
        } catch {}
        taskAborts.delete(taskId);
        taskWorkspaceMap.delete(taskId);
        log.warn("Janitor: cleaned up stuck task", { taskId }, { runningMinutes: Math.round((now - entry.startedAt) / 60000) });
      } else if (!taskAborts.has(taskId)) {
        // Task finished but map entry leaked — clean up
        taskWorkspaceMap.delete(taskId);
      }
    }
  } catch (err: any) {
    log.error("Stuck-task janitor error", undefined, { error: err.message });
  }
}, 5 * 60_000); // Run every 5 minutes

/**
 * Startup sweep: mark any tasks still "running" from a previous process as errored.
 * Call once after store initialization.
 */
export async function recoverStuckTasks(): Promise<void> {
  try {
    const stuck = await S.listStuckTasks(STUCK_TASK_THRESHOLD_MS);
    for (const task of stuck) {
      await S.updateTaskRun(task.id, {
        status: "error",
        answer: "Task was interrupted by a server restart.",
        completedAt: Date.now(),
      });
      log.info("Startup: marked stuck task as error", { taskId: task.id }, { ageMinutes: Math.round((Date.now() - task.createdAt) / 60000) });
    }
    if (stuck.length > 0) {
      log.info("Startup: recovered stuck tasks", undefined, { count: stuck.length });
    }
  } catch (err: any) {
    log.error("Startup stuck-task recovery failed", undefined, { error: err.message });
  }
}

/**
 * Fail all pending tool executions for a disconnected browser session.
 * Called by the relay when a managed session WebSocket closes.
 * This avoids the agent loop waiting up to 15-35s for a timeout on each tool.
 */
export function onSessionDisconnected(browserSessionId: string): void {
  let failed = 0;
  for (const [requestId, pending] of pendingToolExec) {
    if (pending.browserSessionId === browserSessionId) {
      clearTimeout(pending.timeout);
      pendingToolExec.delete(requestId);
      pending.reject(new Error(`Browser session ${browserSessionId} disconnected`));
      failed++;
    }
  }
  if (failed > 0) {
    log.warn("Failed pending tool executions for disconnected session", { sessionId: browserSessionId }, { count: failed });
  }
}

/**
 * Initialize the managed API.
 */
export function initManagedAPI(
  relay: WebSocketClient,
  sessionConnectedCheck?: (id: string) => boolean
): void {
  relayConnection = relay;
  if (sessionConnectedCheck) {
    isSessionConnectedFn = sessionConnectedCheck;
  }
}

/**
 * Handle incoming relay messages (tool results from extension).
 */
export function handleRelayMessage(message: any): boolean {
  if (message?.type === "tool_result" && message.requestId) {
    const pending = pendingToolExec.get(message.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingToolExec.delete(message.requestId);

      // Persist tab context if reported by extension — only if the browserSessionId
      // matches the session that initiated this tool execution (prevents cross-session writes).
      if (message.tabContext?.tabId && message.tabContext.browserSessionId === pending.browserSessionId) {
        try {
          void Promise.resolve(
            S.updateSessionContext(
              pending.browserSessionId,
              message.tabContext.tabId,
              message.tabContext.windowId
            )
          ).catch(() => {});
        } catch {}
      }

      pending.resolve({
        success: !message.error,
        output: message.result ?? message.output,
        error: message.error,
        screenshot: message.screenshot
          ? { data: message.screenshot, mediaType: "image/jpeg" }
          : undefined,
      });
      return true;
    }
  }
  return false;
}

/**
 * Execute a tool on a specific browser session via the relay.
 * Uses targetSessionId for session-based routing.
 */
async function executeToolViaRelay(
  toolName: string,
  toolInput: Record<string, any>,
  browserSessionId: string
): Promise<ToolResult> {
  if (!relayConnection) {
    throw new Error("Relay not connected");
  }

  const requestId = randomUUID();

  // Per-tool timeout: wait/navigate can take longer; most tools should be fast
  const toolTimeoutMs =
    toolName === "computer" && toolInput?.action === "wait"
      ? 35_000 // wait action: up to 30s + buffer
      : toolName === "navigate"
      ? 30_000 // navigation can be slow on heavy pages
      : 15_000; // default: 15s for read_page, find, form_input, etc.

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingToolExec.delete(requestId);
      reject(new Error(`Tool execution timed out after ${toolTimeoutMs / 1000}s: ${toolName}`));
    }, toolTimeoutMs);

    pendingToolExec.set(requestId, { resolve, reject, timeout, browserSessionId, createdAt: Date.now() });

    // Route to the specific browser session, not "the extension"
    // targetSessionId = relay routing key (consumed by relay)
    // browserSessionId = included in payload so extension knows which session context to use
    relayConnection!.send({
      type: "mcp_execute_tool",
      requestId,
      targetSessionId: browserSessionId,
      browserSessionId,
      tool: toolName,
      input: toolInput,
    } as any);
  });
}

// --- Auth ---

function extractApiKey(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return null;
}

async function authenticate(req: IncomingMessage): Promise<ApiKey | null> {
  // Try API key first (developer SDK path)
  const key = extractApiKey(req);
  if (key) {
    return S.validateApiKey(key) as any;
  }

  // Try Better Auth session cookie (first-party app path)
  const sessionInfo = await resolveSessionToWorkspace(req);
  if (sessionInfo) {
    // Return a synthetic ApiKey-like object for the session user
    return {
      id: sessionInfo.userId,
      key: "",
      name: "session",
      workspaceId: sessionInfo.workspaceId,
      createdAt: Date.now(),
    };
  }

  return null;
}

// --- Handlers ---

const MAX_TASK_LEN = 10_000;
const MAX_CONTEXT_LEN = 50_000;
const MAX_URL_LEN = 2048;
const TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30-minute max per task

async function handleCreateTask(
  body: any,
  apiKey: ApiKey,
  requestId?: string
): Promise<{ status: number; data: any }> {
  const { task, url, context, browser_session_id } = body;

  // --- Input validation first (400 errors don't burn rate limit quota) ---
  if (!task?.trim()) {
    return { status: 400, data: { error: "task is required" } };
  }
  if (typeof task !== "string" || task.length > MAX_TASK_LEN) {
    return { status: 400, data: { error: `task must be a string of 1-${MAX_TASK_LEN} characters` } };
  }
  if (context !== undefined && (typeof context !== "string" || context.length > MAX_CONTEXT_LEN)) {
    return { status: 400, data: { error: `context must be a string under ${MAX_CONTEXT_LEN} characters` } };
  }
  if (url !== undefined) {
    if (typeof url !== "string" || url.length > MAX_URL_LEN) {
      return { status: 400, data: { error: `url must be a string under ${MAX_URL_LEN} characters` } };
    }
    try {
      new URL(url);
    } catch {
      return { status: 400, data: { error: "url must be a valid URL" } };
    }
  }

  // browser_session_id is REQUIRED for managed tasks
  if (!browser_session_id) {
    return {
      status: 400,
      data: { error: "browser_session_id is required. Create one via POST /v1/browser-sessions/pair" },
    };
  }

  // --- Credit check (free tier + paid credits) ---
  const allowance = await S.checkTaskAllowance(apiKey.workspaceId);
  if (!allowance.allowed) {
    return {
      status: 402,
      data: {
        error: allowance.reason,
        free_remaining: allowance.freeRemaining,
        credit_balance: allowance.creditBalance,
      },
    };
  }

  // --- Rate limit + concurrency (checked AFTER validation so bad requests don't burn quota) ---
  if (!checkRateLimit(apiKey.workspaceId)) {
    return {
      status: 429,
      data: { error: `Rate limit exceeded. Max ${RATE_LIMIT_MAX_TASKS} tasks per minute.` },
    };
  }

  const running = countConcurrentTasks(apiKey.workspaceId);
  if (running >= MAX_CONCURRENT_TASKS) {
    return {
      status: 429,
      data: { error: `Concurrent task limit reached (${MAX_CONCURRENT_TASKS}). Wait for running tasks to complete.` },
    };
  }

  // Validate session exists and belongs to this workspace
  const session = await S.getBrowserSession(browser_session_id);
  if (!session) {
    return { status: 404, data: { error: "Browser session not found" } };
  }
  if (session.workspaceId !== apiKey.workspaceId) {
    return { status: 403, data: { error: "Browser session does not belong to your workspace" } };
  }

  // Validate session is connected
  const connected = isSessionConnectedFn
    ? isSessionConnectedFn(browser_session_id)
    : session.status === "connected";
  if (!connected) {
    return {
      status: 409,
      data: { error: "Browser session is not connected. The extension must be running and registered." },
    };
  }

  // Check session hasn't expired (relay connectivity alone isn't enough)
  if (session.expiresAt && session.expiresAt < Date.now()) {
    return {
      status: 409,
      data: { error: "Browser session has expired. Re-pair the extension." },
    };
  }

  const taskRun = await S.createTaskRun({
    workspaceId: apiKey.workspaceId,
    apiKeyId: apiKey.id,
    task,
    url,
    context,
    browserSessionId: browser_session_id,
  });

  const abort = new AbortController();
  taskAborts.set(taskRun.id, abort);
  taskWorkspaceMap.set(taskRun.id, { workspaceId: apiKey.workspaceId, startedAt: Date.now() });

  // Task-level timeout — abort if agent loop exceeds max duration
  const taskTimeout = setTimeout(() => {
    abort.abort();
    log.error("Task timed out", { requestId, taskId: taskRun.id, workspaceId: apiKey.workspaceId }, { timeoutMinutes: TASK_TIMEOUT_MS / 60000 });
  }, TASK_TIMEOUT_MS);

  // Track current step for screenshot association
  let currentStep = 0;

  // Run agent loop in background
  runAgentLoop({
    task,
    url,
    context,
    executeTool: async (toolName, toolInput) => {
      const startMs = Date.now();
      const result = await executeToolViaRelay(toolName, toolInput, browser_session_id);
      // Save screenshot from tool result (best-effort)
      if (result.screenshot?.data) {
        S.insertTaskStep({
          taskRunId: taskRun.id,
          step: currentStep,
          status: "screenshot",
          toolName,
          screenshot: result.screenshot.data,
          durationMs: Date.now() - startMs,
        }).catch(() => {});
      }
      return result;
    },
    onStep: (step) => {
      currentStep = step.step;
      S.updateTaskRun(taskRun.id, { steps: step.step });
      // Persist step details for observability
      S.insertTaskStep({
        taskRunId: taskRun.id,
        step: step.step,
        status: step.status,
        toolName: step.toolName,
        toolInput: step.toolInput,
        output: step.text,
      }).catch(() => {}); // best-effort, don't block agent loop
    },
    maxSteps: 50,
    signal: abort.signal,
  })
    .then(async (result: AgentLoopResult) => {
      const status = result.status === "complete" ? "complete" : "error";
      // Deduct credit ONLY for completed tasks — errors/timeouts are free
      if (status === "complete") {
        try {
          const source = await S.deductTaskCredit(apiKey.workspaceId);
          log.info("Task credit deducted", { taskId: taskRun.id, workspaceId: apiKey.workspaceId }, { source });
        } catch (err: any) {
          log.warn("Credit deduction failed", { taskId: taskRun.id }, { error: err.message });
        }
      }
      // Record usage BEFORE marking task complete — if this fails, we retry or log.
      // This ordering prevents "complete task with no billing event" scenarios.
      try {
        await S.recordUsage({
          workspaceId: apiKey.workspaceId,
          apiKeyId: apiKey.id,
          taskRunId: taskRun.id,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          apiCalls: result.usage.apiCalls,
          model: result.model || "gemini-2.5-flash",
        });
      } catch (usageErr: any) {
        log.warn("Task usage recording failed", { taskId: taskRun.id, workspaceId: apiKey.workspaceId }, { error: usageErr.message });
      }
      // Report to Stripe if billing is enabled
      if (isBillingEnabled()) {
        await recordTaskUsage({
          workspaceId: apiKey.workspaceId,
          taskId: taskRun.id,
          steps: result.steps,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        }).catch((err: any) => log.warn("Stripe usage metering failed", { taskId: taskRun.id }, { error: err.message }));
      }
      // Retry-safe task status update — if first attempt fails, retry once.
      // Without this, a DB hiccup leaves the task permanently "running".
      let updated = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await S.updateTaskRun(taskRun.id, {
            status,
            answer: result.answer,
            steps: result.steps,
            usage: result.usage,
            completedAt: Date.now(),
          });
          updated = true;
          break;
        } catch (updateErr: any) {
          if (attempt === 0) {
            log.warn("Task status update failed, retrying", { taskId: taskRun.id }, { error: updateErr.message });
            await new Promise(r => setTimeout(r, 1000));
          } else {
            log.error("Task status update FAILED permanently — may be stuck in running", { taskId: taskRun.id }, { error: updateErr.message });
          }
        }
      }
      if (updated) {
        log.info("Task completed", { requestId, taskId: taskRun.id, workspaceId: apiKey.workspaceId }, { status, steps: result.steps });
      }
    })
    .catch(async (err: any) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await S.updateTaskRun(taskRun.id, {
            status: "error",
            answer: `Agent loop crashed: ${err.message}`,
            completedAt: Date.now(),
          });
          break;
        } catch (updateErr: any) {
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, 1000));
          } else {
            log.error("Task error status update FAILED permanently", { taskId: taskRun.id }, { error: updateErr.message });
          }
        }
      }
      log.error("Task crashed", { requestId, taskId: taskRun.id, workspaceId: apiKey.workspaceId }, { error: err.message });
    })
    .finally(() => {
      clearTimeout(taskTimeout);
      taskAborts.delete(taskRun.id);
      taskWorkspaceMap.delete(taskRun.id);
    });

  return {
    status: 201,
    data: {
      id: taskRun.id,
      status: "running",
      task,
      browser_session_id,
      created_at: taskRun.createdAt,
    },
  };
}

// --- HTTP Server ---

const MAX_BODY_BYTES = 128 * 1024; // 128 KB max request body

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", (chunk: Buffer | string) => {
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Explicit allow-list of origins — production only in production, includes localhost in dev
const ALLOWED_ORIGINS = [
  "https://browse.hanzilla.co",
  "https://api.hanzilla.co",
  ...(process.env.NODE_ENV === "production" ? [] : [
    "http://localhost:3000",
    "http://localhost:5173", // Vite dev server
  ]),
];

/**
 * Send a JSON response with CORS headers.
 * `req` is passed explicitly — no global mutable state. This is safe under concurrent requests.
 */
function sendJson(req: IncomingMessage, res: ServerResponse, status: number, data: any): void {
  const origin = req.headers?.origin || "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
  // Include request ID header if set (available on all responses for tracing)
  const rid = (req as any)._requestId;
  if (rid) headers["X-Request-Id"] = rid;
  // CORS: only echo back origins from the explicit allow-list.
  // Never use `*` with credentials — browsers reject it per the CORS spec.
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Workspace-Id";
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const { method, url } = req;
  const requestId = randomUUID().slice(0, 8);
  (req as any)._requestId = requestId;

  if (method === "OPTIONS") {
    // CORS preflight — return headers with empty body (204 No Content)
    const origin = req.headers?.origin || "";
    const headers: Record<string, string> = { "Vary": "Origin" };
    if (ALLOWED_ORIGINS.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Workspace-Id";
      headers["Access-Control-Allow-Credentials"] = "true";
      headers["Access-Control-Max-Age"] = "86400";
    }
    res.writeHead(204, headers);
    res.end();
    return;
  }

  try {
    // --- Better Auth routes (/api/auth/*) ---
    if (url?.startsWith("/api/auth")) {
      const auth = createAuth();
      if (auth) {
        // Use Better Auth's built-in Node handler for correct OAuth flow
        try {
          const { toNodeHandler } = await import("better-auth/node");
          const handler = toNodeHandler(auth);
          await handler(req, res);
        } catch (authErr: any) {
          log.error("Better Auth handler error", { requestId }, { error: authErr.message, url });
          if (!res.headersSent) {
            sendJson(req, res, 500, { error: "Auth error: " + authErr.message });
          }
        }
        return;
      }
      sendJson(req, res, 503, { error: "Auth not configured. Set DATABASE_URL and Google OAuth credentials." });
      return;
    }

    // --- Dashboard + root redirect ---

    // Serve dashboard static files from dist/dashboard/
    if (method === "GET" && url?.startsWith("/dashboard")) {
      const thisFile = new URL(import.meta.url).pathname;
      const dashboardDir = join(thisFile, "../../dashboard");
      let filePath = url === "/dashboard" || url === "/dashboard/"
        ? join(dashboardDir, "index.html")
        : join(dashboardDir, url.replace("/dashboard/", ""));

      if (existsSync(filePath)) {
        const ext = extname(filePath);
        const mimeTypes: Record<string, string> = {
          ".html": "text/html", ".js": "application/javascript",
          ".css": "text/css", ".json": "application/json",
          ".svg": "image/svg+xml", ".png": "image/png",
        };
        res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
        res.end(readFileSync(filePath));
        return;
      }
      // SPA fallback — serve index.html for unmatched dashboard routes
      const indexPath = join(dashboardDir, "index.html");
      if (existsSync(indexPath)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(readFileSync(indexPath));
        return;
      }
    }

    if (method === "GET" && url === "/") {
      // Authenticated users → dashboard. Others → landing page.
      const session = await resolveSessionToWorkspace(req);
      if (session) {
        res.writeHead(302, { Location: "/dashboard" });
        res.end();
      } else {
        res.writeHead(302, { Location: "https://browse.hanzilla.co" });
        res.end();
      }
      return;
    }

    // --- Serve landing pages locally (docs, etc.) ---
    if (method === "GET" && (url === "/docs.html" || url?.startsWith("/docs.html"))) {
      const landingDir = join(process.cwd(), "landing");
      const filePath = join(landingDir, url === "/docs.html" || url?.startsWith("/docs.html") ? "docs.html" : "index.html");
      if (existsSync(filePath)) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(readFileSync(filePath));
        return;
      }
    }

    // --- Embeddable pairing snippet ---
    if (method === "GET" && url === "/hanzi-pair.js") {
      const snippetPath = join(process.cwd(), "sdk/hanzi-pair.js");
      if (existsSync(snippetPath)) {
        res.writeHead(200, {
          "Content-Type": "application/javascript",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        });
        res.end(readFileSync(snippetPath));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    // --- Hosted pairing page (/pair/:token) ---
    const pairMatch = url?.match(/^\/pair\/(.+)$/);
    if (method === "GET" && pairMatch) {
      const token = pairMatch[1];
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getPairingPageHtml(token, req.headers.host || ""));
      return;
    }

    // --- No-auth endpoints ---

    if (method === "GET" && url === "/v1/health") {
      let dbOk = true;
      try {
        // Use a valid UUID that won't match any real workspace.
        // Returns null (not found) if DB is up. Throws if DB is down.
        await Promise.resolve(S.getWorkspace("00000000-0000-0000-0000-000000000000"));
      } catch {
        dbOk = false;
      }
      const allOk = !!relayConnection && dbOk;
      sendJson(req, res, allOk ? 200 : 503, {
        status: allOk ? "ok" : "degraded",
        version: process.env.npm_package_version || "dev",
        uptime_seconds: Math.round(process.uptime()),
        store_type: process.env.DATABASE_URL ? "postgres" : "file",
        relay_connected: !!relayConnection,
        database_connected: dbOk,
        active_tasks: taskAborts.size,
        pending_tool_executions: pendingToolExec.size,
      });
      return;
    }

    // Profile endpoint (session cookie auth — for developer console)
    if (method === "GET" && url === "/v1/me") {
      const profile = await resolveSessionProfile(req);
      if (!profile) {
        sendJson(req, res, 401, { error: "Not signed in" });
        return;
      }
      sendJson(req, res, 200, {
        user: { name: profile.userName, email: profile.userEmail },
        workspace: { id: profile.workspaceId, name: profile.workspaceName, plan: profile.plan },
      });
      return;
    }

    // Stripe webhook (no API key — uses Stripe signature verification)
    if (method === "POST" && url === "/v1/billing/webhook") {
      if (!isBillingEnabled()) {
        sendJson(req, res, 503, { error: "Billing not configured" });
        return;
      }
      const rawBody = await new Promise<string>((resolve, reject) => {
        let body = "";
        req.on("data", (chunk: string) => (body += chunk));
        req.on("end", () => resolve(body));
        req.on("error", reject);
      });
      const sig = req.headers["stripe-signature"] as string;
      if (!sig) {
        sendJson(req, res, 400, { error: "Missing stripe-signature header" });
        return;
      }
      const result = await handleWebhook(rawBody, sig);
      sendJson(req, res, result.handled ? 200 : 400, { received: result.handled, event: result.event });
      return;
    }

    // Browser session registration (uses pairing token, not API key)
    if (method === "POST" && url === "/v1/browser-sessions/register") {
      const body = await parseBody(req);
      const { pairing_token } = body;
      if (!pairing_token) {
        sendJson(req, res, 400, { error: "pairing_token is required" });
        return;
      }
      const session = await S.consumePairingToken(pairing_token);
      if (!session) {
        sendJson(req, res, 401, { error: "Invalid, expired, or already consumed pairing token" });
        return;
      }
      sendJson(req, res, 201, {
        browser_session_id: session.id,
        session_token: session.sessionToken,
        workspace_id: session.workspaceId,
      });
      return;
    }

    // --- Authenticated endpoints ---

    const apiKey = await authenticate(req);
    if (!apiKey) {
      sendJson(req, res, 401, {
        error: "Authentication required. Use Authorization: Bearer hic_live_xxx (API key) or sign in at /api/auth/sign-in/social",
      });
      return;
    }

    // --- Browser Sessions ---

    // Create pairing token
    if (method === "POST" && url === "/v1/browser-sessions/pair") {
      const body = await parseBody(req);
      const label = typeof body.label === "string" ? body.label.slice(0, 200) : undefined;
      const externalUserId = typeof body.external_user_id === "string" ? body.external_user_id.slice(0, 200) : undefined;
      const token = await S.createPairingToken(apiKey.workspaceId, apiKey.id, { label, externalUserId });
      sendJson(req, res, 201, {
        pairing_token: token._plainToken,
        expires_at: token.expiresAt,
        expires_in_seconds: Math.round((token.expiresAt - Date.now()) / 1000),
      });
      return;
    }

    // List browser sessions
    if (method === "GET" && url === "/v1/browser-sessions") {
      const sessions = await S.listBrowserSessions(apiKey.workspaceId);
      sendJson(req, res, 200, {
        sessions: sessions.map((s) => ({
          id: s.id,
          status: isSessionConnectedFn ? (isSessionConnectedFn(s.id) ? "connected" : "disconnected") : s.status,
          connected_at: s.connectedAt,
          last_heartbeat: s.lastHeartbeat,
          label: s.label || null,
          external_user_id: s.externalUserId || null,
        })),
      });
      return;
    }

    // Delete a browser session
    const sessionMatch = url?.match(/^\/v1\/browser-sessions\/([^/]+)$/);
    if (sessionMatch && method === "DELETE") {
      const sessionId = sessionMatch[1];
      const deleted = await S.deleteBrowserSession(sessionId, apiKey.workspaceId);
      if (!deleted) {
        sendJson(req, res, 404, { error: "Session not found" });
        return;
      }
      sendJson(req, res, 200, { id: sessionId, deleted: true });
      return;
    }

    // --- Tasks ---

    if (method === "POST" && url === "/v1/tasks") {
      const body = await parseBody(req);
      const result = await handleCreateTask(body, apiKey, requestId);
      sendJson(req, res, result.status, result.data);
      return;
    }

    if (method === "GET" && url === "/v1/tasks") {
      const tasks = await S.listTaskRuns(apiKey.workspaceId);
      sendJson(req, res, 200, { tasks });
      return;
    }

    const taskMatch = url?.match(/^\/v1\/tasks\/([^/]+)(\/cancel|\/steps|\/screenshots\/(\d+))?$/);
    if (taskMatch) {
      const taskId = taskMatch[1];
      const run = await S.getTaskRun(taskId);

      if (!run) {
        sendJson(req, res, 404, { error: "Task not found" });
        return;
      }

      // Enforce workspace ownership
      if (run.workspaceId !== apiKey.workspaceId) {
        sendJson(req, res, 404, { error: "Task not found" }); // 404, not 403 — don't leak existence
        return;
      }

      // GET /v1/tasks/:id/steps — execution timeline
      if (method === "GET" && taskMatch[2] === "/steps") {
        const steps = await S.getTaskSteps(taskId);
        sendJson(req, res, 200, { steps });
        return;
      }

      // GET /v1/tasks/:id/screenshots/:step — screenshot at a specific step
      if (method === "GET" && taskMatch[3]) {
        const stepNum = parseInt(taskMatch[3], 10);
        const screenshot = await S.getTaskStepScreenshot(taskId, stepNum);
        if (!screenshot) {
          sendJson(req, res, 404, { error: "No screenshot at this step" });
          return;
        }
        const buf = Buffer.from(screenshot, "base64");
        res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": buf.length });
        res.end(buf);
        return;
      }

      if (method === "GET" && !taskMatch[2]) {
        sendJson(req, res, 200, {
          id: run.id,
          status: run.status,
          task: run.task,
          answer: run.answer,
          steps: run.steps,
          usage: run.usage,
          browser_session_id: run.browserSessionId,
          created_at: run.createdAt,
          completed_at: run.completedAt,
        });
        return;
      }

      if (method === "POST" && taskMatch[2] === "/cancel") {
        if (run.status !== "running") {
          sendJson(req, res, 400, { error: "Task is not running" });
          return;
        }
        const abort = taskAborts.get(taskId);
        if (abort) abort.abort();
        await S.updateTaskRun(taskId, { status: "cancelled", completedAt: Date.now() });
        taskAborts.delete(taskId);
        taskWorkspaceMap.delete(taskId);
        sendJson(req, res, 200, { id: taskId, status: "cancelled" });
        return;
      }
    }

    // --- Usage ---

    if (method === "GET" && url === "/v1/usage") {
      const summary = await S.getUsageSummary(apiKey.workspaceId);
      sendJson(req, res, 200, summary);
      return;
    }

    // --- API Keys (self-serve) ---

    if (method === "POST" && url === "/v1/api-keys") {
      const body = await parseBody(req);
      const name = body.name?.trim();
      if (!name || typeof name !== "string" || name.length > 100) {
        sendJson(req, res, 400, { error: "name is required (string, max 100 chars)" });
        return;
      }
      const newKey = await S.createApiKey(apiKey.workspaceId, name);
      sendJson(req, res, 201, {
        id: newKey.id,
        key: newKey.key, // plaintext — shown once
        name: newKey.name,
        created_at: newKey.createdAt,
        workspace_id: newKey.workspaceId,
        _warning: "Save this key now. It will not be shown again.",
      });
      return;
    }

    if (method === "GET" && url === "/v1/api-keys") {
      const keys = await S.listApiKeys(apiKey.workspaceId);
      sendJson(req, res, 200, {
        api_keys: keys.map((k) => ({
          id: k.id,
          key_prefix: k.keyPrefix ? k.keyPrefix + "..." : k.key.slice(0, 12) + "...",
          name: k.name,
          created_at: k.createdAt,
          last_used_at: k.lastUsedAt,
        })),
      });
      return;
    }

    const apiKeyMatch = url?.match(/^\/v1\/api-keys\/([^/]+)$/);
    if (apiKeyMatch && method === "DELETE") {
      const keyId = apiKeyMatch[1];
      const deleted = await S.deleteApiKey(keyId, apiKey.workspaceId);
      if (!deleted) {
        sendJson(req, res, 404, { error: "API key not found" });
        return;
      }
      sendJson(req, res, 200, { id: keyId, deleted: true });
      return;
    }

    // --- Billing ---

    // GET /v1/billing/credits — check credit balance + free tier status
    if (method === "GET" && url === "/v1/billing/credits") {
      const allowance = await S.checkTaskAllowance(apiKey.workspaceId);
      sendJson(req, res, 200, {
        free_remaining: allowance.freeRemaining,
        credit_balance: allowance.creditBalance,
        free_tasks_per_month: 20,
      });
      return;
    }

    // POST /v1/billing/checkout — buy credits
    if (method === "POST" && url === "/v1/billing/checkout") {
      if (!isBillingEnabled()) {
        sendJson(req, res, 503, { error: "Billing not configured. Contact support." });
        return;
      }
      const body = await parseBody(req);
      const session = await createCheckoutSession({
        workspaceId: apiKey.workspaceId,
        userId: apiKey.id,
        email: body.email,
        credits: body.credits || 100,
        successUrl: body.success_url || "https://api.hanzilla.co/dashboard?checkout=success",
        cancelUrl: body.cancel_url || "https://api.hanzilla.co/dashboard?checkout=cancel",
      });
      sendJson(req, res, 200, session);
      return;
    }

    sendJson(req, res, 404, { error: "Not found" });
  } catch (err: any) {
    log.error("Request error", { requestId }, { method, url, error: err.message });
    sendJson(req, res, 500, { error: err.message, request_id: requestId });
  }
}

export function startManagedAPI(port = 3456): void {
  const host = process.env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0";
  const server = createServer(handleRequest);
  server.listen(port, host, () => {
    log.info("Managed API listening", undefined, { host, port });
  });
}

/**
 * Graceful shutdown: abort all running tasks and update their status.
 * Called on SIGTERM/SIGINT to avoid leaving tasks in a permanent "running" state.
 */
export async function shutdownManagedAPI(): Promise<void> {
  const runningCount = taskAborts.size;
  if (runningCount === 0) return;

  log.info("Shutting down: aborting running tasks", undefined, { count: runningCount });

  const shutdownPromises: Promise<void>[] = [];
  for (const [taskId, abort] of taskAborts) {
    abort.abort();
    shutdownPromises.push(
      (async () => {
        try {
          await Promise.resolve(
            S.updateTaskRun(taskId, {
              status: "error",
              answer: "Task interrupted by server shutdown.",
              completedAt: Date.now(),
            })
          );
        } catch (err: any) {
          log.error("Failed to update task on shutdown", { taskId }, { error: err.message });
        }
      })()
    );
  }

  await Promise.allSettled(shutdownPromises);
  taskAborts.clear();
  taskWorkspaceMap.clear();
  log.info("Shutdown complete", undefined, { tasksAborted: runningCount });
}

// ─── Hosted Pairing Page ─────────────────────────────────

function getPairingPageHtml(token: string, host: string): string {
  const apiUrl = host.includes("localhost") ? `http://${host}` : `https://${host}`;
  const extensionUrl = "https://chromewebstore.google.com/detail/hanzi-in-chrome/iklpkemlmbhemkiojndpbhoakgikpmcd";
  // Escape token for safe embedding in HTML
  const safeToken = token.replace(/[<>"'&]/g, "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect your browser — Hanzi</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #f7f3ea; color: #1f1711; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; }
    .card { max-width: 420px; width: 100%; background: #fffdf8; border: 1px solid #e5ddd0; border-radius: 16px; padding: 32px; text-align: center; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
    p { font-size: 15px; color: #6d6256; line-height: 1.6; margin-bottom: 20px; }
    .status { padding: 16px; border-radius: 10px; margin-bottom: 16px; font-size: 14px; font-weight: 500; }
    .status-connecting { background: #fceee4; color: #8d4524; }
    .status-success { background: #e8f0ec; color: #2f4a3d; }
    .status-error { background: #fce4e4; color: #c62828; }
    .status-install { background: #f5f1e8; color: #6d6256; }
    a { color: #ad5a34; font-weight: 600; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #e5ddd0; border-top-color: #ad5a34; border-radius: 50%; animation: spin 0.8s linear infinite; margin-right: 8px; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .small { font-size: 12px; color: #6d6256; margin-top: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect your browser</h1>
    <p>This will connect your Chrome browser so the app can run tasks in it securely.</p>
    <div id="status" class="status status-connecting">
      <span class="spinner"></span> Detecting Hanzi extension...
    </div>
    <p class="small">Powered by <a href="https://browse.hanzilla.co">Hanzi</a></p>
  </div>

  <script>
    const TOKEN = "${safeToken}";
    const API_URL = "${apiUrl}";
    const EXTENSION_URL = "${extensionUrl}";
    const statusEl = document.getElementById("status");

    let extensionReady = false;

    window.addEventListener("message", (e) => {
      if (e.data?.type === "HANZI_EXTENSION_READY") {
        extensionReady = true;
        pair();
      }
      if (e.data?.type === "HANZI_PAIR_RESULT") {
        if (e.data.success) {
          statusEl.className = "status status-success";
          statusEl.innerHTML = "✓ Browser connected! You can close this tab.";
        } else {
          statusEl.className = "status status-error";
          statusEl.innerHTML = "Pairing failed: " + (e.data.error || "unknown error") + ". The token may have expired.";
        }
      }
    });

    function pair() {
      statusEl.className = "status status-connecting";
      statusEl.innerHTML = '<span class="spinner"></span> Connecting...';
      window.postMessage({ type: "HANZI_PAIR", token: TOKEN, apiUrl: API_URL }, "*");
    }

    // Ping extension
    window.postMessage({ type: "HANZI_PING" }, "*");

    // If extension not detected after 2s, show install prompt
    setTimeout(() => {
      if (!extensionReady) {
        statusEl.className = "status status-install";
        statusEl.innerHTML = 'Hanzi extension not found. <a href="' + EXTENSION_URL + '" target="_blank">Install it here</a>, then reload this page.';
      }
    }, 2000);
  </script>
</body>
</html>`;
}
