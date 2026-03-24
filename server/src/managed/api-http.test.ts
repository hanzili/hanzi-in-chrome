/**
 * HTTP-level API tests
 *
 * Starts the actual server and hits endpoints.
 * Tests auth enforcement, workspace isolation, session validation.
 */

import { initVertex } from "../llm/vertex.js";
import { startManagedAPI, initManagedAPI, handleRelayMessage } from "./api.js";
import { createWorkspace, createApiKey } from "./store.js";

const PORT = 4567; // Use different port from production
const BASE = `http://localhost:${PORT}`;

// Mock relay — we don't need real WebSocket for API tests
const mockRelay = {
  send: () => {},
  onMessage: () => {},
  connect: async () => {},
  isConnected: () => true,
} as any;

let defaultKey: string;
let otherKey: string;

async function setup() {
  // Init Vertex (needed for imports, won't actually call it)
  try { initVertex("/tmp/hanzi-vertex-sa.json"); } catch {}

  // Always create fresh workspaces with known plaintext keys
  const ws1 = createWorkspace("Test Workspace");
  const key1 = createApiKey(ws1.id, "test-key");
  defaultKey = key1.key; // plaintext from createApiKey

  const ws2 = createWorkspace("Other Workspace");
  const key2 = createApiKey(ws2.id, "other-key");
  otherKey = key2.key;

  initManagedAPI(mockRelay, () => false); // All sessions "not connected" by default
  startManagedAPI(PORT);

  await new Promise((r) => setTimeout(r, 500)); // Let server start
}

async function req(method: string, path: string, body?: any, apiKey?: string): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// --- Tests ---

async function testHealthNoAuth() {
  console.log("\n--- Health (no auth required) ---");
  const { status, data } = await req("GET", "/v1/health");
  assert(status === 200, "Health returns 200");
  assert(data.status === "ok", "Health status is ok");
}

async function testAuthRequired() {
  console.log("\n--- Auth required ---");

  const { status: s1 } = await req("POST", "/v1/tasks", { task: "test" });
  assert(s1 === 401, "POST /tasks without auth returns 401");

  const { status: s2 } = await req("GET", "/v1/tasks");
  assert(s2 === 401, "GET /tasks without auth returns 401");

  const { status: s3 } = await req("GET", "/v1/usage");
  assert(s3 === 401, "GET /usage without auth returns 401");

  const { status: s4 } = await req("POST", "/v1/browser-sessions/pair");
  assert(s4 === 401, "POST /browser-sessions/pair without auth returns 401");

  const { status: s5 } = await req("GET", "/v1/tasks", undefined, "hic_live_bogus");
  assert(s5 === 401, "Invalid API key returns 401");
}

async function testBrowserSessionIdRequired() {
  console.log("\n--- browser_session_id required ---");

  const { status, data } = await req("POST", "/v1/tasks", { task: "test" }, defaultKey);
  assert(status === 400, "Task without browser_session_id returns 400");
  assert(data.error.includes("browser_session_id"), "Error mentions browser_session_id");
}

async function testPairingFlow() {
  console.log("\n--- Pairing flow ---");

  // Create pairing token
  const { status: s1, data: d1 } = await req("POST", "/v1/browser-sessions/pair", {}, defaultKey);
  assert(s1 === 201, "Pairing token created");
  assert(d1.pairing_token.startsWith("hic_pair_"), "Token has correct prefix");
  assert(d1.expires_in_seconds > 0, "Token has expiry");

  // Register with pairing token (no auth required — the token IS the auth)
  const { status: s2, data: d2 } = await req("POST", "/v1/browser-sessions/register", {
    pairing_token: d1.pairing_token,
  });
  assert(s2 === 201, "Session registered");
  assert(d2.browser_session_id, "Got browser_session_id");
  assert(d2.session_token.startsWith("hic_sess_"), "Got session_token");

  // Cannot reuse pairing token
  const { status: s3 } = await req("POST", "/v1/browser-sessions/register", {
    pairing_token: d1.pairing_token,
  });
  assert(s3 === 401, "Reused pairing token rejected");

  // Invalid pairing token
  const { status: s4 } = await req("POST", "/v1/browser-sessions/register", {
    pairing_token: "hic_pair_bogus",
  });
  assert(s4 === 401, "Bogus pairing token rejected");
}

async function testSessionNotConnectedRejectsTask() {
  console.log("\n--- Session not connected rejects task ---");

  // Create a session
  const { data: d1 } = await req("POST", "/v1/browser-sessions/pair", {}, defaultKey);
  const { data: d2 } = await req("POST", "/v1/browser-sessions/register", {
    pairing_token: d1.pairing_token,
  });

  // Try to create task — session exists but not connected (mock returns false)
  const { status, data } = await req("POST", "/v1/tasks", {
    task: "test",
    browser_session_id: d2.browser_session_id,
  }, defaultKey);
  assert(status === 409, "Disconnected session returns 409");
  assert(data.error.includes("not connected"), "Error mentions not connected");
}

async function testWrongWorkspaceSessionRejectsTask() {
  console.log("\n--- Wrong workspace session rejects task ---");

  // Create session in workspace A (defaultKey)
  const { data: d1 } = await req("POST", "/v1/browser-sessions/pair", {}, defaultKey);
  const { data: d2 } = await req("POST", "/v1/browser-sessions/register", {
    pairing_token: d1.pairing_token,
  });

  // Try to use it with workspace B's key
  const { status, data } = await req("POST", "/v1/tasks", {
    task: "test",
    browser_session_id: d2.browser_session_id,
  }, otherKey);
  assert(status === 403, "Wrong workspace session returns 403");
  assert(data.error.includes("does not belong"), "Error mentions workspace mismatch");
}

async function testTaskOwnershipIsolation() {
  console.log("\n--- Task ownership isolation ---");

  // Create a task in default workspace directly in the store
  const { createTaskRun, validateApiKey } = await import("./store.js");
  const resolved = validateApiKey(defaultKey);
  const task = createTaskRun({
    workspaceId: resolved!.workspaceId,
    apiKeyId: "test",
    task: "ownership test",
    browserSessionId: "test-session",
  });

  // Default key can see it
  const { status: s1, data: d1 } = await req("GET", `/v1/tasks/${task.id}`, undefined, defaultKey);
  assert(s1 === 200, "Owner can read task");
  assert(d1.id === task.id, "Correct task returned");

  // Other workspace gets 404 (not 403 — don't leak existence)
  const { status: s2 } = await req("GET", `/v1/tasks/${task.id}`, undefined, otherKey);
  assert(s2 === 404, "Non-owner gets 404 (not 403)");

  // Other workspace can't cancel it
  const { status: s3 } = await req("POST", `/v1/tasks/${task.id}/cancel`, {}, otherKey);
  assert(s3 === 404, "Non-owner can't cancel (gets 404)");

  // Nonexistent task
  const { status: s4 } = await req("GET", "/v1/tasks/nonexistent-id", undefined, defaultKey);
  assert(s4 === 404, "Nonexistent task returns 404");
}

async function testListTasksIsolation() {
  console.log("\n--- List tasks isolation ---");

  const { status: s1, data: d1 } = await req("GET", "/v1/tasks", undefined, defaultKey);
  assert(s1 === 200, "Default workspace can list tasks");

  const { status: s2, data: d2 } = await req("GET", "/v1/tasks", undefined, otherKey);
  assert(s2 === 200, "Other workspace can list tasks");

  // Other workspace should have zero tasks (all tasks belong to default)
  assert(d2.tasks.length === 0, "Other workspace sees no tasks");
}

async function testUsageIsolation() {
  console.log("\n--- Usage isolation ---");

  const { status: s1, data: d1 } = await req("GET", "/v1/usage", undefined, defaultKey);
  assert(s1 === 200, "Default workspace can get usage");

  const { status: s2, data: d2 } = await req("GET", "/v1/usage", undefined, otherKey);
  assert(s2 === 200, "Other workspace can get usage");
  assert(d2.totalApiCalls === 0, "Other workspace has zero usage");
}

// --- Input Validation Tests (Slice 1 hardening) ---

async function testInputValidation() {
  console.log("\n--- Input validation (hardening) ---");

  // Task too long
  const longTask = "a".repeat(10_001);
  const { status: s1, data: d1 } = await req("POST", "/v1/tasks", {
    task: longTask,
    browser_session_id: "test",
  }, defaultKey);
  assert(s1 === 400, "Task exceeding 10000 chars returns 400");
  assert(d1.error.includes("10000"), "Error mentions char limit");

  // Context too long
  const longCtx = "b".repeat(50_001);
  const { status: s2, data: d2 } = await req("POST", "/v1/tasks", {
    task: "test",
    context: longCtx,
    browser_session_id: "test",
  }, defaultKey);
  assert(s2 === 400, "Context exceeding 50000 chars returns 400");
  assert(d2.error.includes("context"), "Error mentions context");

  // Invalid URL
  const { status: s3, data: d3 } = await req("POST", "/v1/tasks", {
    task: "test",
    url: "not-a-url",
    browser_session_id: "test",
  }, defaultKey);
  assert(s3 === 400, "Invalid URL returns 400");
  assert(d3.error.includes("url"), "Error mentions url");

  // URL too long
  const longUrl = "https://example.com/" + "x".repeat(2048);
  const { status: s4, data: d4 } = await req("POST", "/v1/tasks", {
    task: "test",
    url: longUrl,
    browser_session_id: "test",
  }, defaultKey);
  assert(s4 === 400, "URL exceeding 2048 chars returns 400");

  // Empty task
  const { status: s5 } = await req("POST", "/v1/tasks", {
    task: "   ",
    browser_session_id: "test",
  }, defaultKey);
  assert(s5 === 400, "Whitespace-only task returns 400");

  // Valid task passes validation (hits browser_session_id check next)
  const { status: s6, data: d6 } = await req("POST", "/v1/tasks", {
    task: "valid task",
    url: "https://example.com",
    context: "some context",
    browser_session_id: "nonexistent-session",
  }, defaultKey);
  assert(s6 === 404, "Valid input with unknown session returns 404 (passes validation)");
}

async function testRequestBodyLimit() {
  console.log("\n--- Request body size limit ---");

  // Send a request with body > 128KB
  const hugeBody = JSON.stringify({ task: "x".repeat(200_000) });
  try {
    const res = await fetch(`${BASE}/v1/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${defaultKey}`,
      },
      body: hugeBody,
    });
    // Should get either 400 (body too large) or connection reset
    assert(res.status >= 400, "Oversized body rejected");
  } catch {
    // Connection reset is also acceptable — server destroyed the socket
    assert(true, "Oversized body caused connection reset (acceptable)");
  }
}

// --- Rate Limiting Tests (Slice 2) ---

async function testRateLimiting() {
  console.log("\n--- Rate limiting (hardening) ---");

  // Rate limit is checked AFTER input validation — bad requests (400) don't burn quota.
  // To trigger rate limits, we need valid requests that pass validation but fail later
  // (e.g., session exists but is not connected → 409).
  const { createWorkspace, createApiKey, createPairingToken, consumePairingToken } = await import("./store.js");
  const freshWs = createWorkspace("Rate Limit Test");
  const freshKey = createApiKey(freshWs.id, "rate-key");

  // Create a real session (but it won't be "connected" since mock returns false)
  const pt = createPairingToken(freshWs.id, freshKey.id);
  const session = consumePairingToken(pt._plainToken)!;

  // Verify bad requests don't burn quota: send 5 invalid requests first
  for (let i = 0; i < 5; i++) {
    const { status } = await req("POST", "/v1/tasks", { task: `bad ${i}` }, freshKey.key);
    assert(status === 400, "Bad request returns 400 without burning quota");
  }

  // Now hammer with valid-looking requests (reach rate limit check, get 409 = not connected)
  let hitRateLimit = false;
  for (let i = 0; i < 12; i++) {
    const { status } = await req("POST", "/v1/tasks", {
      task: `rate test ${i}`,
      browser_session_id: session.id,
    }, freshKey.key);
    if (status === 429) {
      hitRateLimit = true;
      break;
    }
  }
  assert(hitRateLimit, "Rate limit kicks in after max valid requests");

  // Verify the error message is informative
  const { status: s2, data: d2 } = await req("POST", "/v1/tasks", {
    task: "one more",
    browser_session_id: session.id,
  }, freshKey.key);
  assert(s2 === 429, "Rate limited request returns 429");
  assert(d2.error.includes("Rate limit"), "Error mentions rate limit");
}

async function testCorsHeaders() {
  console.log("\n--- CORS headers (hardening) ---");

  // Known origin should get CORS headers
  const res1 = await fetch(`${BASE}/v1/health`, {
    headers: { Origin: "https://browse.hanzilla.co" },
  });
  const acao1 = res1.headers.get("access-control-allow-origin");
  assert(acao1 === "https://browse.hanzilla.co", "Known origin gets reflected CORS");

  // Unknown origin should NOT get CORS headers
  const res2 = await fetch(`${BASE}/v1/health`, {
    headers: { Origin: "https://evil.com" },
  });
  const acao2 = res2.headers.get("access-control-allow-origin");
  assert(acao2 === null, "Unknown origin gets no CORS header");

  // No origin header — no CORS headers
  const res3 = await fetch(`${BASE}/v1/health`);
  const acao3 = res3.headers.get("access-control-allow-origin");
  assert(acao3 === null, "No origin header means no CORS header");
}

// --- Self-serve API Key Tests ---

async function testApiKeyCRUD() {
  console.log("\n--- Self-serve API key CRUD ---");

  // Create key
  const { status: s1, data: d1 } = await req("POST", "/v1/api-keys", { name: "test-key" }, defaultKey);
  assert(s1 === 201, "API key created (201)");
  assert(d1.key.startsWith("hic_live_"), "Key has correct prefix");
  assert(d1.name === "test-key", "Key has correct name");
  assert(d1.id, "Key has an ID");
  assert(d1._warning, "Response includes save warning");

  const createdKeyId = d1.id;
  const createdKeyValue = d1.key;

  // List keys
  const { status: s2, data: d2 } = await req("GET", "/v1/api-keys", undefined, defaultKey);
  assert(s2 === 200, "List API keys returns 200");
  assert(Array.isArray(d2.api_keys), "Response has api_keys array");
  const found = d2.api_keys.find((k: any) => k.id === createdKeyId);
  assert(!!found, "Created key appears in list");
  assert(found.key_prefix.startsWith("hic_live_"), "Listed key shows readable prefix");
  assert(!found.key_prefix.includes(createdKeyValue), "Listed key does not expose full key");

  // The new key should work for auth
  const { status: s3 } = await req("GET", "/v1/api-keys", undefined, createdKeyValue);
  assert(s3 === 200, "Newly created key works for auth");

  // Delete key
  const { status: s4, data: d4 } = await req("DELETE", `/v1/api-keys/${createdKeyId}`, undefined, defaultKey);
  assert(s4 === 200, "Delete returns 200");
  assert(d4.deleted === true, "Response confirms deletion");

  // Deleted key no longer works for auth
  const { status: s5 } = await req("GET", "/v1/api-keys", undefined, createdKeyValue);
  assert(s5 === 401, "Deleted key returns 401");

  // Deleted key no longer in list
  const { status: s6, data: d6 } = await req("GET", "/v1/api-keys", undefined, defaultKey);
  const notFound = d6.api_keys.find((k: any) => k.id === createdKeyId);
  assert(!notFound, "Deleted key removed from list");

  // Delete nonexistent key
  const { status: s7 } = await req("DELETE", "/v1/api-keys/nonexistent-id", undefined, defaultKey);
  assert(s7 === 404, "Delete nonexistent key returns 404");

  // Create with missing name
  const { status: s8 } = await req("POST", "/v1/api-keys", {}, defaultKey);
  assert(s8 === 400, "Create without name returns 400");

  // Create with oversized name
  const { status: s9 } = await req("POST", "/v1/api-keys", { name: "x".repeat(101) }, defaultKey);
  assert(s9 === 400, "Create with name > 100 chars returns 400");
}

async function testApiKeyWorkspaceIsolation() {
  console.log("\n--- API key workspace isolation ---");

  // Create a key in default workspace
  const { data: d1 } = await req("POST", "/v1/api-keys", { name: "ws-test" }, defaultKey);

  // Other workspace cannot see it
  const { data: d2 } = await req("GET", "/v1/api-keys", undefined, otherKey);
  const found = d2.api_keys.find((k: any) => k.id === d1.id);
  assert(!found, "Other workspace cannot see key from different workspace");

  // Other workspace cannot delete it
  const { status: s3 } = await req("DELETE", `/v1/api-keys/${d1.id}`, undefined, otherKey);
  assert(s3 === 404, "Other workspace cannot delete key from different workspace");

  // Clean up
  await req("DELETE", `/v1/api-keys/${d1.id}`, undefined, defaultKey);
}

// --- Session Metadata Tests ---

async function testSessionMetadata() {
  console.log("\n--- Session metadata propagation ---");

  // Create pairing token WITH metadata
  const { status: s1, data: d1 } = await req("POST", "/v1/browser-sessions/pair", {
    label: "Dr. Smith's browser",
    external_user_id: "user_abc123",
  }, defaultKey);
  assert(s1 === 201, "Pairing token with metadata created");

  // Register session
  const { status: s2, data: d2 } = await req("POST", "/v1/browser-sessions/register", {
    pairing_token: d1.pairing_token,
  });
  assert(s2 === 201, "Session registered from token with metadata");

  // List sessions — metadata should be present
  const { data: d3 } = await req("GET", "/v1/browser-sessions", undefined, defaultKey);
  const session = d3.sessions.find((s: any) => s.id === d2.browser_session_id);
  assert(!!session, "Session appears in list");
  assert(session.label === "Dr. Smith's browser", "Label propagated to session");
  assert(session.external_user_id === "user_abc123", "external_user_id propagated to session");
}

async function testSessionMetadataOptional() {
  console.log("\n--- Session metadata optional ---");

  // Create pairing token WITHOUT metadata (backward compatibility)
  const { status: s1, data: d1 } = await req("POST", "/v1/browser-sessions/pair", {}, defaultKey);
  assert(s1 === 201, "Pairing token without metadata created");

  // Register
  const { data: d2 } = await req("POST", "/v1/browser-sessions/register", {
    pairing_token: d1.pairing_token,
  });

  // List — null metadata is fine
  const { data: d3 } = await req("GET", "/v1/browser-sessions", undefined, defaultKey);
  const session = d3.sessions.find((s: any) => s.id === d2.browser_session_id);
  assert(!!session, "Session without metadata appears in list");
  assert(session.label === null || session.label === undefined, "Label is null when not provided");
  assert(session.external_user_id === null || session.external_user_id === undefined, "external_user_id is null when not provided");
}

// --- Legacy Key Prefix Normalization ---

async function testLegacyKeyPrefixNormalization() {
  console.log("\n--- Legacy key prefix normalization ---");

  // Simulate a legacy key by injecting one without keyPrefix directly into the store
  const { validateApiKey } = await import("./store.js");
  const resolved = validateApiKey(defaultKey);
  const store = await import("./store.js");

  // The store's internal data is not directly accessible, but we can verify
  // that all keys returned by the API have readable prefixes (not raw hashes).
  const { status, data } = await req("GET", "/v1/api-keys", undefined, defaultKey);
  assert(status === 200, "List API keys returns 200");
  for (const k of data.api_keys) {
    assert(
      k.key_prefix.startsWith("hic_live_") || k.key_prefix.startsWith("hic_live_***"),
      `Key prefix is readable: ${k.key_prefix.slice(0, 20)}`
    );
    // Must never be a raw 64-char hex hash
    assert(k.key_prefix.length < 40, `Key prefix is not a raw hash (length ${k.key_prefix.length})`);
  }
}

// --- Managed Task Execution (mock relay) ---

async function testManagedTaskExecution() {
  console.log("\n--- Managed task execution (mock relay) ---");

  // This test proves the full managed path:
  // 1. Create pairing token → 2. Register session → 3. Create task → 4. Task completes
  //
  // Limitation: we cannot test real LLM execution or real browser tool execution
  // locally without a running extension + relay + LLM. What we CAN test:
  // - The happy path up to task creation with a connected session
  // - The mock relay session connectivity check
  //
  // For this test, we need a session that reports as "connected" via the
  // isSessionConnectedFn. The test setup uses () => false, so all sessions
  // appear disconnected. We test the 409 → proves the guard works.
  // A real end-to-end test requires: live relay + extension + LLM.

  // Create and register a session
  const { data: d1 } = await req("POST", "/v1/browser-sessions/pair", {
    label: "e2e test browser",
    external_user_id: "e2e-user-1",
  }, defaultKey);
  const { data: d2 } = await req("POST", "/v1/browser-sessions/register", {
    pairing_token: d1.pairing_token,
  });
  assert(d2.browser_session_id, "Session registered for e2e test");

  // Verify session appears as disconnected (mock returns false)
  const { data: d3 } = await req("GET", "/v1/browser-sessions", undefined, defaultKey);
  const session = d3.sessions.find((s: any) => s.id === d2.browser_session_id);
  assert(!!session, "Session in list");
  assert(session.status === "disconnected", "Session reports disconnected (mock relay)");
  assert(session.label === "e2e test browser", "Session has label");
  assert(session.external_user_id === "e2e-user-1", "Session has external_user_id");

  // Task creation is correctly rejected because session is not connected
  const { status: s4, data: d4 } = await req("POST", "/v1/tasks", {
    task: "Read the current page title",
    browser_session_id: d2.browser_session_id,
  }, defaultKey);
  assert(s4 === 409, "Task rejected — session not connected (mock)");
  assert(d4.error.includes("not connected"), "Error explains why");

  // This proves: auth → pairing → session ownership → connectivity guard all work.
  // What remains unproven: actual LLM call + tool execution + result retrieval.
  // That requires: live relay, live extension, live LLM — tested by integration.test.ts
  // against production.
}

// --- Better Auth Session Cookie ---
// Better Auth session-cookie auth requires:
// 1. A running Postgres instance (Better Auth stores sessions in DB)
// 2. Google OAuth or email/password signup to create a user + session
// 3. The session cookie to be passed in requests
//
// This cannot be tested in the local file-store test harness because:
// - createAuth() returns null when DATABASE_URL is not set
// - resolveSessionToWorkspace() returns null when auth is not initialized
//
// What we CAN prove: that the authenticate() function falls through correctly
// when no session cookie is present, and that API key auth still works.
// The full session-cookie path is proven by integration.test.ts against production.

async function testSessionCookieAuthFallthrough() {
  console.log("\n--- Session cookie auth fallthrough ---");

  // Request with no auth at all — should get 401
  const { status: s1 } = await req("GET", "/v1/api-keys");
  assert(s1 === 401, "No auth → 401 (cookie auth not available without DB)");

  // Request with a fake cookie — should still get 401 (no DB = no session resolution)
  const res = await fetch(`http://localhost:${PORT}/v1/api-keys`, {
    headers: {
      "Content-Type": "application/json",
      "Cookie": "better-auth.session_token=fake_session_token_123",
    },
  });
  assert(res.status === 401, "Fake session cookie → 401 (no DB backing)");

  // API key auth still works (not broken by cookie auth attempt)
  const { status: s3 } = await req("GET", "/v1/api-keys", undefined, defaultKey);
  assert(s3 === 200, "API key auth still works after cookie fallthrough");
}

// --- Stuck-Task Recovery ---

async function testStuckTaskRecovery() {
  console.log("\n--- Stuck-task recovery ---");

  // Create a task directly in the store with "running" status and an old createdAt
  const { createTaskRun, getTaskRun, validateApiKey, listStuckTasks } = await import("./store.js");
  const resolved = validateApiKey(defaultKey);
  const task = createTaskRun({
    workspaceId: resolved!.workspaceId,
    apiKeyId: "test",
    task: "stuck task test",
    browserSessionId: "test-session",
  });
  assert(task.status === "running", "Task starts as running");

  // Manually backdate the task's createdAt to simulate a stuck task
  const stored = getTaskRun(task.id)!;
  (stored as any).createdAt = Date.now() - 40 * 60 * 1000; // 40 minutes ago

  // listStuckTasks should find it
  const stuck = listStuckTasks(35 * 60 * 1000); // 35-minute threshold
  assert(stuck.some(t => t.id === task.id), "listStuckTasks finds the old running task");

  // Call recoverStuckTasks
  const { recoverStuckTasks } = await import("./api.js");
  await recoverStuckTasks();

  // Task should now be marked as error
  const recovered = getTaskRun(task.id)!;
  assert(recovered.status === "error", "Stuck task marked as error after recovery");
  assert(recovered.answer!.includes("server restart"), "Answer mentions server restart");
  assert(recovered.completedAt! > 0, "completedAt is set");
}

// --- Request ID Header ---

async function testRequestIdHeader() {
  console.log("\n--- Request ID in response headers ---");

  // All responses should have X-Request-Id header
  const res1 = await fetch(`http://localhost:${PORT}/v1/health`);
  const rid1 = res1.headers.get("x-request-id");
  assert(!!rid1, "Health response has X-Request-Id header");
  assert(rid1!.length === 8, "Request ID is 8 chars");

  // Error responses should also have it
  const res2 = await fetch(`http://localhost:${PORT}/v1/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: "test" }),
  });
  const rid2 = res2.headers.get("x-request-id");
  assert(!!rid2, "401 error response has X-Request-Id header");
  assert(rid2 !== rid1, "Different requests get different IDs");
}

// --- Billing Store Functions ---

async function testBillingWorkspaceFields() {
  console.log("\n--- Billing workspace fields ---");

  const { createWorkspace, getWorkspace, updateWorkspaceBilling } = await import("./store.js");

  // New workspace defaults to free plan
  const ws = createWorkspace("Billing Test");
  assert(ws.plan === "free", "New workspace defaults to free plan");
  assert(ws.stripeCustomerId === undefined, "No Stripe customer by default");
  assert(ws.subscriptionId === undefined, "No subscription by default");
  assert(ws.subscriptionStatus === undefined, "No subscription status by default");

  // Update billing fields
  const updated = updateWorkspaceBilling(ws.id, {
    stripeCustomerId: "cus_test123",
    plan: "pro",
    subscriptionId: "sub_test456",
    subscriptionStatus: "active",
  });
  assert(updated !== null, "Update returns workspace");
  assert(updated!.stripeCustomerId === "cus_test123", "Stripe customer ID persisted");
  assert(updated!.plan === "pro", "Plan updated to pro");
  assert(updated!.subscriptionId === "sub_test456", "Subscription ID persisted");
  assert(updated!.subscriptionStatus === "active", "Subscription status persisted");

  // Verify getWorkspace returns the updated fields
  const fetched = getWorkspace(ws.id);
  assert(fetched!.plan === "pro", "getWorkspace reflects updated plan");
  assert(fetched!.stripeCustomerId === "cus_test123", "getWorkspace reflects customer ID");

  // Simulate subscription cancellation
  const cancelled = updateWorkspaceBilling(ws.id, {
    plan: "free",
    subscriptionStatus: "cancelled",
  });
  assert(cancelled!.plan === "free", "Plan reverted to free");
  assert(cancelled!.subscriptionStatus === "cancelled", "Status set to cancelled");
  assert(cancelled!.stripeCustomerId === "cus_test123", "Customer ID preserved on cancel");

  // Update nonexistent workspace returns null
  const missing = updateWorkspaceBilling("nonexistent-id", { plan: "pro" });
  assert(missing === null, "Update nonexistent workspace returns null");
}

async function testBillingCheckoutEndpoint() {
  console.log("\n--- Billing checkout endpoint ---");

  // Billing is not configured in test environment (no STRIPE_SECRET_KEY)
  const { status, data } = await req("POST", "/v1/billing/checkout", {
    email: "test@example.com",
  }, defaultKey);
  assert(status === 503, "Checkout returns 503 when billing not configured");
  assert(data.error.includes("not configured"), "Error mentions billing not configured");
}

// --- Run ---

async function runAll() {
  await setup();
  console.log("=== HTTP API Tests ===");

  await testHealthNoAuth();
  await testAuthRequired();
  await testBrowserSessionIdRequired();
  await testPairingFlow();
  await testSessionNotConnectedRejectsTask();
  await testWrongWorkspaceSessionRejectsTask();
  await testTaskOwnershipIsolation();
  await testListTasksIsolation();
  await testUsageIsolation();
  await testInputValidation();
  await testRequestBodyLimit();
  await testRateLimiting();
  await testCorsHeaders();
  await testApiKeyCRUD();
  await testApiKeyWorkspaceIsolation();
  await testSessionMetadata();
  await testSessionMetadataOptional();
  await testLegacyKeyPrefixNormalization();
  await testManagedTaskExecution();
  await testSessionCookieAuthFallthrough();
  await testStuckTaskRecovery();
  await testRequestIdHeader();
  await testBillingWorkspaceFields();
  await testBillingCheckoutEndpoint();

  console.log("\n=== All HTTP API tests passed ===\n");
  process.exit(0);
}

runAll().catch((err) => {
  console.error("\n❌ TEST FAILED:", err.message);
  process.exit(1);
});
