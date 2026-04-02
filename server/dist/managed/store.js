/**
 * Managed Platform Store
 *
 * File-based persistence for MVP. Swap for Postgres/SQLite later.
 * Stores: API keys, task runs, usage events, browser sessions.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID, randomBytes, createHash } from "crypto";
/** SHA-256 hash for storing tokens/keys at rest */
function hashSecret(secret) {
    return createHash("sha256").update(secret).digest("hex");
}
const DATA_DIR = join(homedir(), ".hanzi-browse", "managed");
let data = {
    workspaces: {},
    apiKeys: {},
    taskRuns: {},
    browserSessions: {},
    pairingTokens: {},
    usageEvents: [],
};
function dataPath() {
    return join(DATA_DIR, "store.json");
}
function load() {
    try {
        if (existsSync(dataPath())) {
            const loaded = JSON.parse(readFileSync(dataPath(), "utf8"));
            // Merge with defaults to handle new fields added after initial creation
            data = {
                workspaces: loaded.workspaces || {},
                apiKeys: loaded.apiKeys || {},
                taskRuns: loaded.taskRuns || {},
                browserSessions: loaded.browserSessions || {},
                pairingTokens: loaded.pairingTokens || {},
                usageEvents: loaded.usageEvents || [],
            };
        }
    }
    catch {
        // Store file missing or corrupt — start fresh (this is expected on first run)
    }
}
function save() {
    mkdirSync(DATA_DIR, { recursive: true });
    // Atomic write: write to temp file then rename.
    // Prevents corruption if process crashes mid-write.
    const tmpPath = dataPath() + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, dataPath());
}
// Init on import
load();
// --- Workspace ---
export function createWorkspace(name) {
    const ws = {
        id: randomUUID(),
        name,
        createdAt: Date.now(),
        plan: "free",
        creditBalance: 0,
        freeTasksThisMonth: 0,
        freeTasksResetAt: Date.now(),
    };
    data.workspaces[ws.id] = ws;
    save();
    return ws;
}
export function getWorkspace(id) {
    return data.workspaces[id] || null;
}
// --- Credits (file store — no enforcement, always allow) ---
export function checkTaskAllowance(_workspaceId) {
    return { allowed: true, source: "free", freeRemaining: 999, creditBalance: 0 };
}
export function deductTaskCredit(_workspaceId) {
    return "free";
}
export function addCredits(_workspaceId, _amount) {
    return 0;
}
export function updateWorkspaceBilling(id, fields) {
    const ws = data.workspaces[id];
    if (!ws)
        return null;
    if (fields.stripeCustomerId !== undefined)
        ws.stripeCustomerId = fields.stripeCustomerId;
    if (fields.plan !== undefined)
        ws.plan = fields.plan;
    if (fields.subscriptionId !== undefined)
        ws.subscriptionId = fields.subscriptionId;
    if (fields.subscriptionStatus !== undefined)
        ws.subscriptionStatus = fields.subscriptionStatus;
    save();
    return ws;
}
// --- API Keys ---
export function createApiKey(workspaceId, name, type = "secret") {
    const prefix = type === "publishable" ? "hic_pub_" : "hic_live_";
    const key = `${prefix}${randomBytes(24).toString("hex")}`;
    const keyHash = hashSecret(key);
    const keyPrefix = key.slice(0, 20);
    const apiKey = {
        id: randomUUID(),
        key: keyHash, // Store hash, not plaintext
        keyPrefix,
        name,
        workspaceId,
        createdAt: Date.now(),
        type,
    };
    data.apiKeys[keyHash] = apiKey;
    save();
    // Return with the plaintext key — caller shows it once, then it's gone
    return { ...apiKey, key };
}
export function validateApiKey(key) {
    const keyHash = hashSecret(key);
    const apiKey = data.apiKeys[keyHash];
    if (!apiKey)
        return null;
    apiKey.lastUsedAt = Date.now();
    return apiKey;
}
export function listApiKeys(workspaceId) {
    return Object.values(data.apiKeys)
        .filter((k) => k.workspaceId === workspaceId)
        .map((k) => ({
        ...k,
        // Normalize: old keys created before keyPrefix was added have no prefix.
        // Use a truncated "hic_..." placeholder so the API never exposes raw hashes.
        keyPrefix: k.keyPrefix || "hic_live_***",
    }));
}
export function deleteApiKey(id, workspaceId) {
    for (const [hash, key] of Object.entries(data.apiKeys)) {
        if (key.id === id && key.workspaceId === workspaceId) {
            delete data.apiKeys[hash];
            save();
            return true;
        }
    }
    return false;
}
// --- Task Runs ---
export function createTaskRun(params) {
    const run = {
        id: randomUUID(),
        ...params,
        status: "running",
        steps: 0,
        usage: { inputTokens: 0, outputTokens: 0, apiCalls: 0 },
        createdAt: Date.now(),
    };
    data.taskRuns[run.id] = run;
    save();
    return run;
}
export function updateTaskRun(id, updates) {
    const run = data.taskRuns[id];
    if (!run)
        return null;
    Object.assign(run, updates);
    save();
    return run;
}
export function getTaskRun(id) {
    return data.taskRuns[id] || null;
}
export function listStuckTasks(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    return Object.values(data.taskRuns)
        .filter((t) => t.status === "running" && t.createdAt < cutoff);
}
export function listTaskRuns(workspaceId, limit = 50) {
    return Object.values(data.taskRuns)
        .filter((r) => r.workspaceId === workspaceId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit);
}
// --- Pairing Tokens ---
const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Create a short-lived pairing token. The developer (via API key) requests this,
 * then gives it to the browser user. The extension exchanges it for a session token.
 * The workspace binding comes from the API key, NOT from the extension.
 */
export function createPairingToken(workspaceId, apiKeyId, metadata) {
    const plainToken = `hic_pair_${randomBytes(32).toString("hex")}`;
    const tokenHash = hashSecret(plainToken);
    const token = {
        token: tokenHash, // Store hash
        workspaceId,
        createdBy: apiKeyId,
        createdAt: Date.now(),
        expiresAt: Date.now() + PAIRING_TOKEN_TTL_MS,
        consumed: false,
        label: metadata?.label,
        externalUserId: metadata?.externalUserId,
    };
    data.pairingTokens[tokenHash] = token;
    save();
    return { ...token, _plainToken: plainToken };
}
/**
 * Consume a pairing token and create a browser session.
 * Returns null if the token is invalid, expired, or already consumed.
 * The workspace is inherited from the pairing token — the extension cannot choose it.
 */
export function consumePairingToken(pairingTokenStr) {
    const tokenHash = hashSecret(pairingTokenStr);
    const pt = data.pairingTokens[tokenHash];
    if (!pt)
        return null;
    if (pt.consumed)
        return null;
    if (Date.now() > pt.expiresAt)
        return null;
    // Mark consumed
    pt.consumed = true;
    // Create session with backend-issued credentials (30-day expiry)
    // Metadata (label, externalUserId) is inherited from the pairing token.
    const plainSessionToken = `hic_sess_${randomBytes(32).toString("hex")}`;
    const now = Date.now();
    const session = {
        id: randomUUID(),
        workspaceId: pt.workspaceId, // Bound by backend, not extension
        sessionToken: hashSecret(plainSessionToken), // Store hash
        status: "connected",
        connectedAt: now,
        lastHeartbeat: now,
        expiresAt: now + 30 * 24 * 60 * 60 * 1000, // 30 days
        revoked: false,
        label: pt.label,
        externalUserId: pt.externalUserId,
    };
    data.browserSessions[session.id] = session;
    save();
    // Return with plaintext session token — shown once to the extension
    return { ...session, sessionToken: plainSessionToken };
}
// --- Browser Sessions ---
/**
 * Validate a session token. Returns the session if valid, null otherwise.
 * This is how the relay authenticates extension connections.
 */
export function validateSessionToken(sessionToken) {
    const tokenHash = hashSecret(sessionToken);
    for (const session of Object.values(data.browserSessions)) {
        if (session.sessionToken === tokenHash) {
            // Check expiry and revocation
            if (session.revoked)
                return null;
            if (session.expiresAt && Date.now() > session.expiresAt)
                return null;
            return session;
        }
    }
    return null;
}
export function heartbeatSession(id) {
    const session = data.browserSessions[id];
    if (!session)
        return false;
    // Reject heartbeat for revoked or expired sessions
    if (session.revoked)
        return false;
    if (session.expiresAt && Date.now() > session.expiresAt)
        return false;
    session.lastHeartbeat = Date.now();
    session.status = "connected";
    // Don't save on every heartbeat — batch to avoid disk thrashing
    // Save every 30 seconds via periodic flush instead
    return true;
}
/**
 * Rotate a session's token. Returns the new plaintext token, or null if session is invalid.
 * The old token is immediately invalidated (replaced by the new hash).
 * Call this periodically (e.g., on heartbeat from relay) to limit token exposure window.
 */
export function rotateSessionToken(id) {
    const session = data.browserSessions[id];
    if (!session)
        return null;
    if (session.revoked)
        return null;
    if (session.expiresAt && Date.now() > session.expiresAt)
        return null;
    const newPlainToken = `hic_sess_${randomBytes(32).toString("hex")}`;
    session.sessionToken = hashSecret(newPlainToken);
    save();
    return newPlainToken;
}
// Periodic flush for heartbeat updates
let _heartbeatFlushTimer = null;
export function startHeartbeatFlush() {
    if (_heartbeatFlushTimer)
        return;
    _heartbeatFlushTimer = setInterval(() => save(), 30000);
}
export function disconnectSession(id) {
    const session = data.browserSessions[id];
    if (session) {
        session.status = "disconnected";
        save();
    }
}
export function updateSessionContext(id, tabId, windowId) {
    const session = data.browserSessions[id];
    if (session) {
        session.tabId = tabId;
        if (windowId !== undefined)
            session.windowId = windowId;
        save();
    }
}
export function getBrowserSession(id) {
    return data.browserSessions[id] || null;
}
export function getBrowserSessionByToken(sessionToken) {
    return validateSessionToken(sessionToken);
}
export function listBrowserSessions(workspaceId) {
    const sessions = Object.values(data.browserSessions);
    if (workspaceId) {
        return sessions.filter((s) => s.workspaceId === workspaceId);
    }
    return sessions;
}
export function deleteBrowserSession(id, workspaceId) {
    const session = data.browserSessions[id];
    if (!session || session.workspaceId !== workspaceId)
        return false;
    delete data.browserSessions[id];
    save();
    return true;
}
// --- Task Steps (no-op for file store — only persisted in Postgres) ---
export async function insertTaskStep(_params) { }
export async function getTaskSteps(_taskRunId) { return []; }
export async function getTaskStepScreenshot(_taskRunId, _step) { return null; }
// --- Usage Events ---
export function recordUsage(params) {
    // Gemini 2.5 Flash pricing
    const inputCost = (params.inputTokens / 1_000_000) * 0.30;
    const outputCost = (params.outputTokens / 1_000_000) * 2.50;
    const event = {
        id: randomUUID(),
        ...params,
        costUsd: inputCost + outputCost,
        createdAt: Date.now(),
    };
    data.usageEvents.push(event);
    save();
    return event;
}
export function getUsageSummary(workspaceId, since) {
    const events = data.usageEvents.filter((e) => e.workspaceId === workspaceId && (!since || e.createdAt >= since));
    return {
        totalInputTokens: events.reduce((s, e) => s + e.inputTokens, 0),
        totalOutputTokens: events.reduce((s, e) => s + e.outputTokens, 0),
        totalApiCalls: events.reduce((s, e) => s + e.apiCalls, 0),
        totalCostUsd: events.reduce((s, e) => s + e.costUsd, 0),
        taskCount: new Set(events.map((e) => e.taskRunId)).size,
    };
}
// --- Bootstrap: ensure a default workspace + key exist ---
export function ensureDefaultWorkspace() {
    const existing = Object.values(data.workspaces)[0];
    if (existing) {
        const key = Object.values(data.apiKeys).find((k) => k.workspaceId === existing.id);
        if (key)
            return { workspace: existing, apiKey: key };
        return { workspace: existing, apiKey: createApiKey(existing.id, "default") };
    }
    const workspace = createWorkspace("Default");
    const apiKey = createApiKey(workspace.id, "default");
    return { workspace, apiKey };
}
// --- Automation stubs (file store doesn't support automations — Postgres only) ---
const NOT_SUPPORTED = "Automations require Postgres (set DATABASE_URL)";
export async function createAutomation(_p) { throw new Error(NOT_SUPPORTED); }
export async function getAutomation(_id) { return null; }
export async function listAutomations(_wid) { return []; }
export async function updateAutomation(_id, _wid, _f) { return null; }
export async function deleteAutomation(_id, _wid) { return false; }
export async function getDueAutomations() { return []; }
export async function createDraftBatch(_p) { return []; }
export async function listDrafts(_wid, _f) { return []; }
export async function getDraft(_id) { return null; }
export async function updateDraft(_id, _wid, _f) { return null; }
export async function logEngagement(_p) { }
export async function getRecentlyEngagedHandles(_wid, _d) { return []; }
export async function listEngagements(_wid, _l) { return []; }
