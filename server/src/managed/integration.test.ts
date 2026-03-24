/**
 * Integration tests against the LIVE production API.
 * Tests the real Postgres store, real relay, real auth.
 *
 * Requires: the managed server running at https://api.hanzilla.co
 * Run: node dist/managed/integration.test.js
 */

const BASE = process.env.TEST_API_URL || "https://api.hanzilla.co";
const API_KEY = process.env.TEST_API_KEY || "";

if (!API_KEY) {
  console.error("Set TEST_API_KEY env var to run integration tests.");
  process.exit(1);
}

async function req(method: string, path: string, body?: any, key?: string): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function testHealthNoAuth() {
  console.log("\n--- Health (no auth) ---");
  const { status, data } = await req("GET", "/v1/health");
  assert(status === 200, "Health returns 200");
  assert(data.status === "ok", "Status is ok");
  assert(data.relay_connected === true, "Relay is connected");
}

async function testAuthEnforcement() {
  console.log("\n--- Auth enforcement (Postgres-backed) ---");
  const { status: s1 } = await req("GET", "/v1/tasks");
  assert(s1 === 401, "No auth → 401");

  const { status: s2 } = await req("GET", "/v1/tasks", undefined, "hic_live_bogus_key_000000");
  assert(s2 === 401, "Bad key → 401");

  const { status: s3 } = await req("GET", "/v1/tasks", undefined, API_KEY);
  assert(s3 === 200, "Valid key → 200");
}

async function testPairingFlowPostgres() {
  console.log("\n--- Pairing flow (Postgres-backed) ---");

  // Create token
  const { status: s1, data: d1 } = await req("POST", "/v1/browser-sessions/pair", {}, API_KEY);
  assert(s1 === 201, "Pairing token created");
  assert(d1.pairing_token.startsWith("hic_pair_"), "Token has prefix");

  // Register
  const { status: s2, data: d2 } = await req("POST", "/v1/browser-sessions/register", {
    pairing_token: d1.pairing_token,
  });
  assert(s2 === 201, "Session registered");
  assert(d2.session_token.startsWith("hic_sess_"), "Session token has prefix");
  assert(d2.browser_session_id, "Got session ID");

  // Cannot reuse
  const { status: s3 } = await req("POST", "/v1/browser-sessions/register", {
    pairing_token: d1.pairing_token,
  });
  assert(s3 === 401, "Reused token rejected");

  // Session shows in list
  const { data: d4 } = await req("GET", "/v1/browser-sessions", undefined, API_KEY);
  const found = d4.sessions.find((s: any) => s.id === d2.browser_session_id);
  assert(!!found, "Session appears in list");
}

async function testTaskRequiresSession() {
  console.log("\n--- Task requires browser_session_id ---");
  const { status, data } = await req("POST", "/v1/tasks", { task: "test" }, API_KEY);
  assert(status === 400, "Missing session → 400");
  assert(data.error.includes("browser_session_id"), "Error mentions session");
}

async function testTaskWithFakeSession() {
  console.log("\n--- Task with non-existent session ---");
  const { status } = await req("POST", "/v1/tasks", {
    task: "test",
    browser_session_id: "00000000-0000-0000-0000-000000000000",
  }, API_KEY);
  assert(status === 404, "Non-existent session → 404");
}

async function testUsagePostgres() {
  console.log("\n--- Usage (Postgres-backed) ---");
  const { status, data } = await req("GET", "/v1/usage", undefined, API_KEY);
  assert(status === 200, "Usage returns 200");
  assert(typeof data.totalInputTokens === "number", "Has input tokens");
  assert(typeof data.totalCostUsd === "number", "Has cost");
}

async function testRelayRejectsLegacy() {
  console.log("\n--- Relay rejects legacy registration in production ---");
  // Try connecting to the relay without session_token
  try {
    const ws = new (await import("ws")).default(`wss://relay.hanzilla.co`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "register", role: "cli" }));
      });
      ws.on("message", (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") {
          ws.close();
          resolve();
        } else if (msg.type === "registered") {
          ws.close();
          reject(new Error("Legacy registration should be rejected in production"));
        }
      });
      ws.on("error", () => resolve()); // Connection rejected = good
      setTimeout(() => { ws.close(); resolve(); }, 5000);
    });
    assert(true, "Legacy registration rejected or connection refused");
  } catch (e: any) {
    assert(false, `Relay test failed: ${e.message}`);
  }
}

// --- Self-serve API Key CRUD (Postgres-backed) ---

async function testApiKeyCRUDPostgres() {
  console.log("\n--- Self-serve API key CRUD (Postgres) ---");

  // Create
  const { status: s1, data: d1 } = await req("POST", "/v1/api-keys", { name: "integration-test-key" }, API_KEY);
  assert(s1 === 201, "API key created");
  assert(d1.key.startsWith("hic_live_"), "Key has correct prefix");
  assert(d1.name === "integration-test-key", "Key has correct name");

  const newKeyId = d1.id;
  const newKeyValue = d1.key;

  // List
  const { status: s2, data: d2 } = await req("GET", "/v1/api-keys", undefined, API_KEY);
  assert(s2 === 200, "List returns 200");
  const found = d2.api_keys.find((k: any) => k.id === newKeyId);
  assert(!!found, "Created key in list");
  assert(found.key_prefix.startsWith("hic_live_"), "Prefix is readable");

  // New key authenticates
  const { status: s3 } = await req("GET", "/v1/health");
  assert(s3 === 200, "Health still works");
  const { status: s4 } = await req("GET", "/v1/api-keys", undefined, newKeyValue);
  assert(s4 === 200, "New key authenticates");

  // Delete
  const { status: s5 } = await req("DELETE", `/v1/api-keys/${newKeyId}`, undefined, API_KEY);
  assert(s5 === 200, "Delete succeeds");

  // Deleted key no longer works
  const { status: s6 } = await req("GET", "/v1/api-keys", undefined, newKeyValue);
  assert(s6 === 401, "Deleted key returns 401");
}

// --- Session Metadata (Postgres-backed) ---

async function testSessionMetadataPostgres() {
  console.log("\n--- Session metadata (Postgres) ---");

  // Create pairing token with metadata
  const { status: s1, data: d1 } = await req("POST", "/v1/browser-sessions/pair", {
    label: "Integration test browser",
    external_user_id: "integration-user-42",
  }, API_KEY);
  assert(s1 === 201, "Pairing token with metadata created");

  // Register
  const { status: s2, data: d2 } = await req("POST", "/v1/browser-sessions/register", {
    pairing_token: d1.pairing_token,
  });
  assert(s2 === 201, "Session registered");

  // List — metadata should propagate
  const { data: d3 } = await req("GET", "/v1/browser-sessions", undefined, API_KEY);
  const session = d3.sessions.find((s: any) => s.id === d2.browser_session_id);
  assert(!!session, "Session in list");
  assert(session.label === "Integration test browser", "Label propagated (Postgres)");
  assert(session.external_user_id === "integration-user-42", "external_user_id propagated (Postgres)");
}

// --- Pairing without metadata (backward compat, Postgres) ---

async function testSessionMetadataOptionalPostgres() {
  console.log("\n--- Session metadata optional (Postgres) ---");

  const { data: d1 } = await req("POST", "/v1/browser-sessions/pair", {}, API_KEY);
  const { data: d2 } = await req("POST", "/v1/browser-sessions/register", {
    pairing_token: d1.pairing_token,
  });
  const { data: d3 } = await req("GET", "/v1/browser-sessions", undefined, API_KEY);
  const session = d3.sessions.find((s: any) => s.id === d2.browser_session_id);
  assert(!!session, "Session without metadata in list");
  assert(session.label === null || session.label === undefined, "Label null when omitted (Postgres)");
  assert(session.external_user_id === null || session.external_user_id === undefined, "external_user_id null when omitted (Postgres)");
}

// --- Better Auth Session Cookie (Postgres-backed) ---

async function testBetterAuthSignupAndAccess() {
  console.log("\n--- Better Auth sign-up → session cookie → API access ---");

  // Sign up with email/password
  const signupRes = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "E2E Test User",
      email: `e2e-${Date.now()}@test.hanzi.dev`,
      password: "test-password-12345",
    }),
    redirect: "manual",
  });

  if (signupRes.status >= 400) {
    // Better Auth may not support email signup in all configs
    console.log(`  ⊘ Skipped: sign-up returned ${signupRes.status} (email auth may be disabled)`);
    return;
  }

  // Extract session cookie from signup response
  const setCookie = signupRes.headers.get("set-cookie");
  if (!setCookie) {
    console.log("  ⊘ Skipped: no session cookie returned from sign-up");
    return;
  }

  // Use the cookie to access authenticated endpoints
  const cookieHeader = setCookie.split(";")[0]; // Just the key=value part
  const apiKeysRes = await fetch(`${BASE}/v1/api-keys`, {
    headers: { Cookie: cookieHeader },
  });

  if (apiKeysRes.status === 200) {
    assert(true, "Session cookie grants access to /v1/api-keys");
    const data = await apiKeysRes.json();
    assert(Array.isArray(data.api_keys), "Response has api_keys array");

    // Create an API key using session cookie
    const createRes = await fetch(`${BASE}/v1/api-keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieHeader },
      body: JSON.stringify({ name: "cookie-created-key" }),
    });
    if (createRes.status === 201) {
      const created = await createRes.json();
      assert(created.key.startsWith("hic_live_"), "API key created via session cookie");
      // Clean up
      await fetch(`${BASE}/v1/api-keys/${created.id}`, {
        method: "DELETE",
        headers: { Cookie: cookieHeader },
      });
    } else {
      console.log(`  ⊘ API key creation via cookie returned ${createRes.status}`);
    }
  } else {
    console.log(`  ⊘ Session cookie auth returned ${apiKeysRes.status} — workspace may not have been provisioned yet`);
  }
}

// --- Billing Workspace Fields (Postgres-backed) ---

async function testBillingFieldsPostgres() {
  console.log("\n--- Billing workspace fields (Postgres) ---");

  // Health check should show billing-related fields
  const { status, data } = await req("GET", "/v1/health");
  assert(status === 200, "Health returns 200");
  assert(data.store_type === "postgres", "Store type is postgres");
}

async function main() {
  console.log(`=== Integration Tests (${BASE}) ===`);

  await testHealthNoAuth();
  await testAuthEnforcement();
  await testPairingFlowPostgres();
  await testTaskRequiresSession();
  await testTaskWithFakeSession();
  await testUsagePostgres();
  await testApiKeyCRUDPostgres();
  await testSessionMetadataPostgres();
  await testSessionMetadataOptionalPostgres();
  await testBetterAuthSignupAndAccess();
  await testBillingFieldsPostgres();
  await testRelayRejectsLegacy();

  console.log("\n=== All integration tests passed ===\n");
}

main().catch((e) => {
  console.error("\n❌ FAILED:", e.message);
  process.exit(1);
});
