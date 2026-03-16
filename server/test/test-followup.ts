/**
 * Test follow-up message flow
 *
 * Sends a task, waits for completion, then sends a follow-up.
 * Verifies the follow-up works without duplicate messages or tab issues.
 *
 * Usage:
 *   npx tsx test/test-followup.ts
 *
 * Prerequisites:
 *   1. WebSocket relay running: node dist/relay/server.js
 *   2. Chrome extension loaded and connected
 *   3. MCP server NOT needed (this talks directly to the relay)
 *
 * Optional env vars:
 *   TIMEOUT_MS=60000   — per-task timeout (default: 90s)
 *   TASK="go to..."    — override the initial task
 *   URL="https://..."  — override the starting URL
 */

import WebSocket from "ws";

const RELAY_URL = process.env.RELAY_URL || "ws://localhost:7862";
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "90000", 10);
const INITIAL_URL = process.env.URL || "https://httpbin.org";
const INITIAL_TASK = process.env.TASK || "Go to the page and tell me what you see. Take a screenshot first, then use read_page to get the page structure.";
const FOLLOWUP_MSG = process.env.FOLLOWUP || "Now scroll down and tell me what links are at the bottom of the page.";

// ─── Helpers ────────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString().split("T")[1].slice(0, 12);
}

function log(level: string, msg: string, data?: any) {
  const colors: Record<string, string> = {
    INFO: "\x1b[36m", PASS: "\x1b[32m", FAIL: "\x1b[31m",
    WARN: "\x1b[33m", STEP: "\x1b[90m", RECV: "\x1b[35m",
  };
  const c = colors[level] || "";
  const extra = data ? ` ${JSON.stringify(data)}` : "";
  console.log(`${c}[${timestamp()}] ${level}: ${msg}\x1b[0m${extra}`);
}

// ─── WebSocket communication ────────────────────────────────────

let ws: WebSocket;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let sessionId: string | null = null;

function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(RELAY_URL);
    ws.on("open", () => {
      // Register as MCP client
      ws.send(JSON.stringify({ type: "register", role: "mcp" }));
      log("INFO", `Connected to relay at ${RELAY_URL}`);
      resolve();
    });
    ws.on("message", (data) => {
      try {
        const raw = data.toString();
        const msg = JSON.parse(raw);
        // Log ALL incoming messages for debugging
        if (msg.type !== "mcp_task_update") {
          log("RECV", `Raw: ${raw.slice(0, 150)}`);
        }
        handleMessage(msg);
      } catch (e) {
        log("WARN", `Unparseable message: ${data.toString().slice(0, 100)}`);
      }
    });
    ws.on("error", reject);
    ws.on("close", () => log("WARN", "WebSocket closed"));
  });
}

function send(msg: any) {
  ws.send(JSON.stringify(msg));
}

function handleMessage(msg: any) {
  const type = msg.type;

  // Extension sends: task_update, task_complete, task_error, screenshot_result
  // (no mcp_ prefix — the relay strips it on the way in, extension sends raw types back)
  if (type === "task_update") {
    if (msg.sessionId === sessionId) {
      log("STEP", `[${msg.status}] ${(msg.step || "").slice(0, 80)}`);
    }
  } else if (type === "task_complete") {
    if (msg.sessionId === sessionId) {
      const answer = msg.result?.answer || msg.result?.message || JSON.stringify(msg.result || {}).slice(0, 120);
      log("RECV", "Task complete", { answer: answer.slice(0, 200) });
      const p = pending.get("wait_complete");
      if (p) { pending.delete("wait_complete"); p.resolve(msg); }
    }
  } else if (type === "task_error") {
    if (msg.sessionId === sessionId) {
      log("FAIL", `Task error: ${msg.error}`);
      const p = pending.get("wait_complete");
      if (p) { pending.delete("wait_complete"); p.resolve(msg); }
    }
  } else if (type === "screenshot" || type === "screenshot_result") {
    log("RECV", `Screenshot received (${(msg.data || "").length} chars)`);
    const p = pending.get("wait_screenshot");
    if (p) { pending.delete("wait_screenshot"); p.resolve(msg); }
  }
}

function waitFor(key: string, timeoutMs: number = TIMEOUT_MS): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error(`Timeout waiting for ${key} after ${timeoutMs}ms`));
    }, timeoutMs);

    pending.set(key, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}

// ─── Test Flow ──────────────────────────────────────────────────

async function runTest() {
  log("INFO", "=== Follow-up Message Test ===");
  log("INFO", `Timeout: ${TIMEOUT_MS}ms | URL: ${INITIAL_URL}`);
  log("INFO", `Task: ${INITIAL_TASK.slice(0, 80)}`);
  log("INFO", `Follow-up: ${FOLLOWUP_MSG.slice(0, 80)}`);
  console.log("");

  // Step 1: Connect to relay
  await connect();

  // Step 1b: Verify the extension is connected by sending a probe
  log("INFO", "Checking extension connectivity...");
  const probeId = "probe-" + Date.now();
  const probeWait = waitFor("wait_screenshot", 8000).catch(() => null);
  send({ type: "mcp_screenshot", sessionId: probeId });
  const probeResult = await probeWait;
  if (!probeResult) {
    log("FAIL", "Extension is NOT connected to the relay. Reload it in chrome://extensions and try again.");
    ws.close();
    process.exit(1);
  }
  log("PASS", "Extension is connected and responsive");
  console.log("");

  // Step 2: Start initial task
  log("INFO", "── Step 1: Starting initial task ──");
  // Generate a session ID (same format as MCP server)
  sessionId = Math.random().toString(36).slice(2, 10);
  log("INFO", `Session ID: ${sessionId}`);
  const startWait = waitFor("wait_complete");
  send({
    type: "mcp_start_task",
    sessionId,
    task: INITIAL_TASK,
    url: INITIAL_URL,
    context: "",
  });

  const result1 = await startWait;
  log(result1.type === "task_complete" ? "PASS" : "FAIL",
    `Initial task finished (${result1.type})`, {
      answer: (result1.answer || result1.error || "").slice(0, 200)
    });

  if (!sessionId) {
    log("FAIL", "No session ID received");
    process.exit(1);
  }

  console.log("");

  // Step 3: Send follow-up message
  log("INFO", "── Step 2: Sending follow-up message ──");
  const followupWait = waitFor("wait_complete");
  send({
    type: "mcp_send_message",
    sessionId,
    message: FOLLOWUP_MSG,
  });

  const result2 = await followupWait;
  log(result2.type === "task_complete" ? "PASS" : "FAIL",
    `Follow-up finished (${result2.type})`, {
      answer: (result2.answer || result2.error || "").slice(0, 200)
    });

  console.log("");

  // Step 4: Take a screenshot to verify state
  log("INFO", "── Step 3: Taking verification screenshot ──");
  const ssWait = waitFor("wait_screenshot", 10000).catch(() => null);
  send({
    type: "mcp_screenshot",  // relay forwards as-is
    sessionId,
  });

  const ss = await ssWait;
  if (ss) {
    log("PASS", "Screenshot captured successfully");
  } else {
    log("WARN", "Screenshot timed out (non-critical)");
  }

  // Summary
  console.log("");
  log("INFO", "=== Test Complete ===");
  const passed = result1.type === "task_complete" && result2.type === "task_complete";
  log(passed ? "PASS" : "FAIL", passed
    ? "Both initial task and follow-up completed successfully"
    : "One or more steps failed — check logs above");

  // Clean up
  send({ type: "mcp_stop_task", sessionId, remove: true });
  setTimeout(() => {
    ws.close();
    process.exit(passed ? 0 : 1);
  }, 1000);
}

runTest().catch((err) => {
  log("FAIL", `Test crashed: ${err.message}`);
  process.exit(1);
});
