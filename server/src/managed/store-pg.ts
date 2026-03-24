/**
 * Postgres-backed Managed Platform Store
 *
 * Drop-in replacement for store.ts (file-based).
 * Uses Neon Postgres via the `pg` driver.
 * Same exported function signatures — swap by changing the import.
 */

import pg from "pg";
import { randomUUID, randomBytes, createHash } from "crypto";

const { Pool } = pg;

let pool: pg.Pool | null = null;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// --- Types (same as store.ts) ---

export interface ApiKey {
  id: string;
  key: string;
  keyPrefix?: string;
  name: string;
  workspaceId: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  stripeCustomerId?: string;
  plan: "free" | "pro" | "enterprise";
  subscriptionId?: string;
  subscriptionStatus?: "active" | "past_due" | "cancelled";
}

export interface PairingToken {
  token: string;
  workspaceId: string;
  createdBy: string; // API key ID or Better Auth user ID
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  label?: string;
  externalUserId?: string;
}

export interface BrowserSession {
  id: string;
  workspaceId: string;
  sessionToken: string;
  status: "connected" | "disconnected";
  connectedAt: number;
  lastHeartbeat: number;
  tabId?: number;
  windowId?: number;
  label?: string;
  externalUserId?: string;
}

export interface TaskRun {
  id: string;
  workspaceId: string;
  apiKeyId: string;
  browserSessionId?: string;
  task: string;
  url?: string;
  context?: string;
  status: "running" | "complete" | "error" | "cancelled";
  answer?: string;
  steps: number;
  usage: { inputTokens: number; outputTokens: number; apiCalls: number };
  createdAt: number;
  completedAt?: number;
}

export interface UsageEvent {
  id: string;
  workspaceId: string;
  apiKeyId: string;
  taskRunId: string;
  inputTokens: number;
  outputTokens: number;
  apiCalls: number;
  model: string;
  costUsd: number;
  createdAt: number;
}

// --- Init ---

export function initPgStore(connectionString: string): void {
  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
  });
  // Log is imported lazily to avoid circular deps; use direct output here
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "Connected to Postgres" }));
}

function db(): pg.Pool {
  if (!pool) throw new Error("PgStore not initialized. Call initPgStore() first.");
  return pool;
}

// --- Workspace ---

export async function createWorkspace(name: string): Promise<Workspace> {
  const id = randomUUID();
  const now = Date.now();
  await db().query(
    "INSERT INTO workspaces (id, name, created_at, plan) VALUES ($1, $2, $3, 'free')",
    [id, name, new Date(now)]
  );
  return { id, name, createdAt: now, plan: "free" };
}

function rowToWorkspace(r: any): Workspace {
  return {
    id: r.id,
    name: r.name,
    createdAt: new Date(r.created_at).getTime(),
    stripeCustomerId: r.stripe_customer_id || undefined,
    plan: r.plan || "free",
    subscriptionId: r.subscription_id || undefined,
    subscriptionStatus: r.subscription_status || undefined,
  };
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const res = await db().query("SELECT * FROM workspaces WHERE id = $1", [id]);
  if (res.rows.length === 0) return null;
  return rowToWorkspace(res.rows[0]);
}

export async function updateWorkspaceBilling(id: string, fields: {
  stripeCustomerId?: string;
  plan?: Workspace["plan"];
  subscriptionId?: string;
  subscriptionStatus?: Workspace["subscriptionStatus"];
}): Promise<Workspace | null> {
  const sets: string[] = [];
  const vals: any[] = [];
  let idx = 1;
  if (fields.stripeCustomerId !== undefined) { sets.push(`stripe_customer_id = $${idx++}`); vals.push(fields.stripeCustomerId); }
  if (fields.plan !== undefined) { sets.push(`plan = $${idx++}`); vals.push(fields.plan); }
  if (fields.subscriptionId !== undefined) { sets.push(`subscription_id = $${idx++}`); vals.push(fields.subscriptionId); }
  if (fields.subscriptionStatus !== undefined) { sets.push(`subscription_status = $${idx++}`); vals.push(fields.subscriptionStatus); }
  if (sets.length === 0) return getWorkspace(id);
  vals.push(id);
  const res = await db().query(
    `UPDATE workspaces SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    vals
  );
  if (res.rows.length === 0) return null;
  return rowToWorkspace(res.rows[0]);
}

// --- API Keys ---

export async function createApiKey(workspaceId: string, name: string): Promise<ApiKey> {
  const plainKey = `hic_live_${randomBytes(24).toString("hex")}`;
  const keyHash = hashSecret(plainKey);
  const id = randomUUID();
  const now = Date.now();
  await db().query(
    "INSERT INTO api_keys (id, key_hash, key_prefix, name, workspace_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, keyHash, plainKey.slice(0, 20), name, workspaceId, new Date(now)]
  );
  return { id, key: plainKey, name, workspaceId, createdAt: now };
}

export async function validateApiKey(key: string): Promise<ApiKey | null> {
  const keyHash = hashSecret(key);
  const res = await db().query(
    "UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1 RETURNING *",
    [keyHash]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    id: r.id,
    key: keyHash,
    name: r.name,
    workspaceId: r.workspace_id,
    createdAt: new Date(r.created_at).getTime(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).getTime() : undefined,
  };
}

export async function listApiKeys(workspaceId: string): Promise<ApiKey[]> {
  const res = await db().query(
    "SELECT * FROM api_keys WHERE workspace_id = $1 ORDER BY created_at DESC",
    [workspaceId]
  );
  return res.rows.map((r) => ({
    id: r.id,
    key: r.key_prefix + "...",
    keyPrefix: r.key_prefix,
    name: r.name,
    workspaceId: r.workspace_id,
    createdAt: new Date(r.created_at).getTime(),
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).getTime() : undefined,
  }));
}

export async function deleteApiKey(id: string, workspaceId: string): Promise<boolean> {
  const res = await db().query(
    "DELETE FROM api_keys WHERE id = $1 AND workspace_id = $2",
    [id, workspaceId]
  );
  return (res.rowCount ?? 0) > 0;
}

// --- Pairing Tokens ---

export async function createPairingToken(
  workspaceId: string,
  apiKeyId: string,
  metadata?: { label?: string; externalUserId?: string }
): Promise<PairingToken & { _plainToken: string }> {
  const plainToken = `hic_pair_${randomBytes(32).toString("hex")}`;
  const tokenHash = hashSecret(plainToken);
  const now = Date.now();
  const expiresAt = now + 5 * 60 * 1000;
  await db().query(
    "INSERT INTO pairing_tokens (token_hash, workspace_id, created_by, created_at, expires_at, label, external_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [tokenHash, workspaceId, apiKeyId, new Date(now), new Date(expiresAt), metadata?.label || null, metadata?.externalUserId || null]
  );
  return {
    token: tokenHash,
    workspaceId,
    createdBy: apiKeyId,
    createdAt: now,
    expiresAt,
    consumed: false,
    label: metadata?.label,
    externalUserId: metadata?.externalUserId,
    _plainToken: plainToken,
  };
}

export async function consumePairingToken(pairingTokenStr: string): Promise<BrowserSession | null> {
  const tokenHash = hashSecret(pairingTokenStr);
  const res = await db().query(
    "UPDATE pairing_tokens SET consumed = true WHERE token_hash = $1 AND consumed = false AND expires_at > NOW() RETURNING *",
    [tokenHash]
  );
  if (res.rows.length === 0) return null;
  const pt = res.rows[0];

  // Create browser session
  const sessionId = randomUUID();
  const plainSessionToken = `hic_sess_${randomBytes(32).toString("hex")}`;
  const sessionTokenHash = hashSecret(plainSessionToken);
  const now = Date.now();

  // Session tokens expire after 30 days
  const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const expiresAt = now + SESSION_TTL_MS;

  await db().query(
    "INSERT INTO browser_sessions (id, workspace_id, session_token_hash, status, connected_at, last_heartbeat, expires_at, label, external_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [sessionId, pt.workspace_id, sessionTokenHash, "connected", new Date(now), new Date(now), new Date(expiresAt), pt.label || null, pt.external_user_id || null]
  );

  return {
    id: sessionId,
    workspaceId: pt.workspace_id,
    sessionToken: plainSessionToken, // Return plaintext once
    status: "connected",
    connectedAt: now,
    lastHeartbeat: now,
    label: pt.label || undefined,
    externalUserId: pt.external_user_id || undefined,
  } as BrowserSession;
}

// --- Browser Sessions ---

export async function validateSessionToken(sessionToken: string): Promise<BrowserSession | null> {
  const tokenHash = hashSecret(sessionToken);
  const res = await db().query(
    "SELECT * FROM browser_sessions WHERE session_token_hash = $1 AND revoked = false AND (expires_at IS NULL OR expires_at > NOW())",
    [tokenHash]
  );
  if (res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    sessionToken: tokenHash,
    status: r.status,
    connectedAt: new Date(r.connected_at).getTime(),
    lastHeartbeat: new Date(r.last_heartbeat).getTime(),
    tabId: r.tab_id,
    windowId: r.window_id,
  };
}

export async function heartbeatSession(id: string): Promise<boolean> {
  // Only heartbeat if not expired and not revoked
  const res = await db().query(
    "UPDATE browser_sessions SET last_heartbeat = NOW(), status = 'connected' WHERE id = $1 AND revoked = false AND (expires_at IS NULL OR expires_at > NOW())",
    [id]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Rotate a session's token. Returns the new plaintext token, or null if session is invalid.
 * The old token hash is atomically replaced. One-step rotation — no dual-token window.
 */
export async function rotateSessionToken(id: string): Promise<string | null> {
  const newPlainToken = `hic_sess_${randomBytes(32).toString("hex")}`;
  const newHash = hashSecret(newPlainToken);
  const res = await db().query(
    "UPDATE browser_sessions SET session_token_hash = $1 WHERE id = $2 AND revoked = false AND (expires_at IS NULL OR expires_at > NOW()) RETURNING id",
    [newHash, id]
  );
  if ((res.rowCount ?? 0) === 0) return null;
  return newPlainToken;
}

export async function disconnectSession(id: string): Promise<void> {
  await db().query(
    "UPDATE browser_sessions SET status = 'disconnected' WHERE id = $1",
    [id]
  );
}

export async function updateSessionContext(id: string, tabId: number, windowId?: number): Promise<void> {
  await db().query(
    "UPDATE browser_sessions SET tab_id = $1, window_id = $2 WHERE id = $3",
    [tabId, windowId ?? null, id]
  );
}

function rowToSession(r: any): BrowserSession {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    sessionToken: r.session_token_hash,
    status: r.status,
    connectedAt: new Date(r.connected_at).getTime(),
    lastHeartbeat: new Date(r.last_heartbeat).getTime(),
    tabId: r.tab_id,
    windowId: r.window_id,
    label: r.label || undefined,
    externalUserId: r.external_user_id || undefined,
  };
}

export async function getBrowserSession(id: string): Promise<BrowserSession | null> {
  const res = await db().query("SELECT * FROM browser_sessions WHERE id = $1", [id]);
  if (res.rows.length === 0) return null;
  return rowToSession(res.rows[0]);
}

export async function listBrowserSessions(workspaceId?: string): Promise<BrowserSession[]> {
  const query = workspaceId
    ? { text: "SELECT * FROM browser_sessions WHERE workspace_id = $1 ORDER BY connected_at DESC", values: [workspaceId] }
    : { text: "SELECT * FROM browser_sessions ORDER BY connected_at DESC", values: [] };
  const res = await db().query(query);
  return res.rows.map(rowToSession);
}

export async function deleteBrowserSession(id: string, workspaceId: string): Promise<boolean> {
  const res = await db().query(
    "DELETE FROM browser_sessions WHERE id = $1 AND workspace_id = $2",
    [id, workspaceId]
  );
  return (res.rowCount ?? 0) > 0;
}

// --- Task Runs ---

export async function createTaskRun(params: {
  workspaceId: string;
  apiKeyId: string;
  task: string;
  url?: string;
  context?: string;
  browserSessionId?: string;
}): Promise<TaskRun> {
  const id = randomUUID();
  const now = Date.now();
  await db().query(
    `INSERT INTO task_runs (id, workspace_id, api_key_id, browser_session_id, task, url, context, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8)`,
    [id, params.workspaceId, params.apiKeyId, params.browserSessionId ?? null, params.task, params.url ?? null, params.context ?? null, new Date(now)]
  );
  return {
    id,
    ...params,
    status: "running",
    steps: 0,
    usage: { inputTokens: 0, outputTokens: 0, apiCalls: 0 },
    createdAt: now,
  };
}

export async function updateTaskRun(id: string, updates: Partial<TaskRun>): Promise<TaskRun | null> {
  const setClauses: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (updates.status !== undefined) { setClauses.push(`status = $${idx++}`); values.push(updates.status); }
  if (updates.answer !== undefined) { setClauses.push(`answer = $${idx++}`); values.push(updates.answer); }
  if (updates.steps !== undefined) { setClauses.push(`steps = $${idx++}`); values.push(updates.steps); }
  if (updates.usage) {
    setClauses.push(`input_tokens = $${idx++}`); values.push(updates.usage.inputTokens);
    setClauses.push(`output_tokens = $${idx++}`); values.push(updates.usage.outputTokens);
    setClauses.push(`api_calls = $${idx++}`); values.push(updates.usage.apiCalls);
  }
  if (updates.completedAt !== undefined) { setClauses.push(`completed_at = $${idx++}`); values.push(new Date(updates.completedAt)); }

  if (setClauses.length === 0) return null;
  values.push(id);

  const res = await db().query(
    `UPDATE task_runs SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
    values
  );
  if (res.rows.length === 0) return null;
  return rowToTaskRun(res.rows[0]);
}

export async function getTaskRun(id: string): Promise<TaskRun | null> {
  const res = await db().query("SELECT * FROM task_runs WHERE id = $1", [id]);
  if (res.rows.length === 0) return null;
  return rowToTaskRun(res.rows[0]);
}

export async function listStuckTasks(maxAgeMs: number): Promise<TaskRun[]> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const res = await db().query(
    "SELECT * FROM task_runs WHERE status = 'running' AND created_at < $1",
    [cutoff]
  );
  return res.rows.map(rowToTaskRun);
}

export async function listTaskRuns(workspaceId: string, limit = 50): Promise<TaskRun[]> {
  const res = await db().query(
    "SELECT * FROM task_runs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2",
    [workspaceId, limit]
  );
  return res.rows.map(rowToTaskRun);
}

function rowToTaskRun(r: any): TaskRun {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    apiKeyId: r.api_key_id,
    browserSessionId: r.browser_session_id,
    task: r.task,
    url: r.url,
    context: r.context,
    status: r.status,
    answer: r.answer,
    steps: r.steps,
    usage: { inputTokens: r.input_tokens, outputTokens: r.output_tokens, apiCalls: r.api_calls },
    createdAt: new Date(r.created_at).getTime(),
    completedAt: r.completed_at ? new Date(r.completed_at).getTime() : undefined,
  };
}

// --- Usage Events ---

export async function recordUsage(params: {
  workspaceId: string;
  apiKeyId: string;
  taskRunId: string;
  inputTokens: number;
  outputTokens: number;
  apiCalls: number;
  model: string;
}): Promise<UsageEvent> {
  const inputCost = (params.inputTokens / 1_000_000) * 0.30;
  const outputCost = (params.outputTokens / 1_000_000) * 2.50;
  const costUsd = inputCost + outputCost;
  const id = randomUUID();
  const now = Date.now();

  await db().query(
    `INSERT INTO usage_events (id, workspace_id, api_key_id, task_run_id, input_tokens, output_tokens, api_calls, model, cost_usd, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, params.workspaceId, params.apiKeyId, params.taskRunId, params.inputTokens, params.outputTokens, params.apiCalls, params.model, costUsd, new Date(now)]
  );
  return { id, ...params, costUsd, createdAt: now };
}

export async function getUsageSummary(
  workspaceId: string,
  since?: number
): Promise<{
  totalInputTokens: number;
  totalOutputTokens: number;
  totalApiCalls: number;
  totalCostUsd: number;
  taskCount: number;
}> {
  const sinceDate = since ? new Date(since) : new Date(0);
  const res = await db().query(
    `SELECT
       COALESCE(SUM(input_tokens), 0) as total_input,
       COALESCE(SUM(output_tokens), 0) as total_output,
       COALESCE(SUM(api_calls), 0) as total_calls,
       COALESCE(SUM(cost_usd), 0) as total_cost,
       COUNT(DISTINCT task_run_id) as task_count
     FROM usage_events
     WHERE workspace_id = $1 AND created_at >= $2`,
    [workspaceId, sinceDate]
  );
  const r = res.rows[0];
  return {
    totalInputTokens: parseInt(r.total_input),
    totalOutputTokens: parseInt(r.total_output),
    totalApiCalls: parseInt(r.total_calls),
    totalCostUsd: parseFloat(r.total_cost),
    taskCount: parseInt(r.task_count),
  };
}

// --- Bootstrap ---

export async function ensureDefaultWorkspace(): Promise<{ workspace: Workspace; apiKey: ApiKey }> {
  // Check for existing workspace
  const existing = await db().query("SELECT * FROM workspaces LIMIT 1");
  if (existing.rows.length > 0) {
    const ws = rowToWorkspace(existing.rows[0]);
    const keyRes = await db().query("SELECT key_prefix FROM api_keys WHERE workspace_id = $1 LIMIT 1", [ws.id]);
    if (keyRes.rows.length > 0) {
      return {
        workspace: ws,
        apiKey: { id: "", key: `${keyRes.rows[0].key_prefix}... (already created, plaintext not available)`, name: "default", workspaceId: ws.id, createdAt: ws.createdAt },
      };
    }
    const apiKey = await createApiKey(ws.id, "default");
    return { workspace: ws, apiKey };
  }
  const workspace = await createWorkspace("Default");
  const apiKey = await createApiKey(workspace.id, "default");
  return { workspace, apiKey };
}

// --- Heartbeat flush (no-op for Postgres, queries go to DB directly) ---
export function startHeartbeatFlush(): void {
  // Not needed for Postgres — heartbeatSession writes to DB directly
}
