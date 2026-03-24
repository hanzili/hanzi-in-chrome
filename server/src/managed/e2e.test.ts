/**
 * End-to-end managed task test.
 *
 * Tests the full partner flow with a mock-connected session:
 *   1. Create API key
 *   2. Create pairing token with metadata
 *   3. Register session
 *   4. Task creation succeeds (session reports as connected)
 *   5. Task enters "running" state
 *
 * Limitation: cannot test actual agent loop execution (needs LLM + extension).
 * But this proves the full auth → pairing → session → task creation pipeline
 * with a connected session, which is the gap the other tests don't cover.
 */

import { initVertex } from "../llm/vertex.js";
import { startManagedAPI, initManagedAPI } from "./api.js";
import { createWorkspace, createApiKey, consumePairingToken, createPairingToken } from "./store.js";

const PORT = 4569;
const BASE = `http://localhost:${PORT}`;

// Track which sessions should report as "connected"
const connectedSessions = new Set<string>();

const mockRelay = {
  send: () => {},
  onMessage: () => {},
  connect: async () => {},
  isConnected: () => true,
} as any;

let testKey: string;
let testWorkspaceId: string;

async function setup() {
  try { initVertex("/tmp/hanzi-vertex-sa.json"); } catch {}

  const ws = createWorkspace("E2E Test Workspace");
  testWorkspaceId = ws.id;
  const key = createApiKey(ws.id, "e2e-key");
  testKey = key.key;

  // Pass a session connectivity checker that uses our connectedSessions set
  initManagedAPI(mockRelay, (id: string) => connectedSessions.has(id));
  startManagedAPI(PORT);

  await new Promise((r) => setTimeout(r, 500));
}

async function req(method: string, path: string, body?: any, apiKey?: string): Promise<{ status: number; data: any; headers: Headers }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, headers: res.headers };
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function testFullPartnerFlow() {
  console.log("\n--- Full partner flow (connected session) ---");

  // 1. Create pairing token with metadata
  const { status: s1, data: d1 } = await req("POST", "/v1/browser-sessions/pair", {
    label: "E2E test browser",
    external_user_id: "e2e-user-001",
  }, testKey);
  assert(s1 === 201, "Pairing token created");
  assert(d1.pairing_token.startsWith("hic_pair_"), "Token has correct prefix");

  // 2. Register session (simulates extension pairing)
  const { status: s2, data: d2 } = await req("POST", "/v1/browser-sessions/register", {
    pairing_token: d1.pairing_token,
  });
  assert(s2 === 201, "Session registered");
  const sessionId = d2.browser_session_id;
  assert(!!sessionId, "Got session ID");

  // 3. Mark session as connected (simulates relay registering the extension)
  connectedSessions.add(sessionId);

  // 4. Verify session shows as connected
  const { data: d3 } = await req("GET", "/v1/browser-sessions", undefined, testKey);
  const session = d3.sessions.find((s: any) => s.id === sessionId);
  assert(!!session, "Session in list");
  assert(session.status === "connected", "Session reports connected");
  assert(session.label === "E2E test browser", "Label present");
  assert(session.external_user_id === "e2e-user-001", "external_user_id present");

  // 5. Create a task — this should succeed (session is connected)
  const { status: s4, data: d4, headers: h4 } = await req("POST", "/v1/tasks", {
    task: "Read the title of the current page",
    browser_session_id: sessionId,
  }, testKey);
  assert(s4 === 201, "Task created successfully (session is connected)");
  assert(d4.status === "running", "Task status is running");
  assert(d4.id, "Task has an ID");
  assert(!!h4.get("x-request-id"), "Response has X-Request-Id");

  const taskId = d4.id;

  // 6. Task appears in list
  const { data: d5 } = await req("GET", "/v1/tasks", undefined, testKey);
  const task = d5.tasks.find((t: any) => t.id === taskId);
  assert(!!task, "Task appears in list");

  // 7. Task is retrievable by ID
  const { status: s6, data: d6 } = await req("GET", `/v1/tasks/${taskId}`, undefined, testKey);
  assert(s6 === 200, "Task retrievable by ID");
  assert(d6.browser_session_id === sessionId, "Task bound to correct session");

  // 8. Cancel the task (since no real relay/LLM, it would hang otherwise)
  const { status: s7 } = await req("POST", `/v1/tasks/${taskId}/cancel`, {}, testKey);
  assert(s7 === 200, "Task cancelled");

  // 9. Verify cancelled state
  const { data: d8 } = await req("GET", `/v1/tasks/${taskId}`, undefined, testKey);
  assert(d8.status === "cancelled", "Task shows cancelled status");

  // 10. Usage endpoint works
  const { status: s9, data: d9 } = await req("GET", "/v1/usage", undefined, testKey);
  assert(s9 === 200, "Usage endpoint returns 200");
  assert(typeof d9.totalInputTokens === "number", "Usage has token count");

  // Clean up
  connectedSessions.delete(sessionId);
}

async function testConnectedVsDisconnectedBehavior() {
  console.log("\n--- Connected vs disconnected session behavior ---");

  // Create a session
  const pt = createPairingToken(testWorkspaceId, "test");
  const session = consumePairingToken(pt._plainToken)!;

  // Disconnected: task creation should fail
  const { status: s1 } = await req("POST", "/v1/tasks", {
    task: "test",
    browser_session_id: session.id,
  }, testKey);
  assert(s1 === 409, "Disconnected session → 409");

  // Connect
  connectedSessions.add(session.id);

  // Connected: task creation should succeed
  const { status: s2, data: d2 } = await req("POST", "/v1/tasks", {
    task: "test",
    browser_session_id: session.id,
  }, testKey);
  assert(s2 === 201, "Connected session → 201");

  // Cancel to clean up
  await req("POST", `/v1/tasks/${d2.id}/cancel`, {}, testKey);
  connectedSessions.delete(session.id);
}

async function runAll() {
  await setup();
  console.log("=== E2E Managed Task Tests ===");

  await testFullPartnerFlow();
  await testConnectedVsDisconnectedBehavior();

  console.log("\n=== All E2E tests passed ===\n");
  process.exit(0);
}

runAll().catch((err) => {
  console.error("\n❌ E2E TEST FAILED:", err.message);
  process.exit(1);
});
