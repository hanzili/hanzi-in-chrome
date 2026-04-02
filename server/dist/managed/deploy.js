#!/usr/bin/env node
/**
 * Combined Managed Backend + Relay Server
 *
 * Single process for cloud deployment. Runs:
 * 1. WebSocket relay (for extension communication)
 * 2. Managed REST API (for client integration)
 * 3. Vertex AI LLM client
 *
 * Environment variables:
 *   VERTEX_SA_JSON  - Service account JSON string (for cloud deployment)
 *   VERTEX_SA_PATH  - Path to service account JSON file (for local)
 *   PORT            - HTTP/WS port (default: 3456, Railway sets this)
 *   RELAY_PORT      - Internal relay port (default: 7862)
 */
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { initVertex } from "../llm/vertex.js";
import { getClaudeCredentials, getClaudeKeychainCredentials, getCodexCredentials } from "../llm/credentials.js";
import { handleApiProxy } from "../relay/api-proxy.js";
import { startManagedAPI, initManagedAPI, handleRelayMessage, setStoreModule, onSessionDisconnected, shutdownManagedAPI, recoverStuckTasks, runInternalTask } from "./api.js";
import { initScheduler, startScheduler, stopScheduler } from "./scheduler.js";
import { notifyDraftsReady } from "./notify.js";
import { initBilling, setBillingStore } from "./billing.js";
import { WebSocketClient } from "../ipc/websocket-client.js";
import { initManagedTelemetry, shutdownManagedTelemetry } from "./telemetry.js";
// Dynamic store import — Postgres when DATABASE_URL is set, file-based otherwise
const DATABASE_URL = process.env.DATABASE_URL;
let store;
if (DATABASE_URL) {
    const pgStore = await import("./store-pg.js");
    pgStore.initPgStore(DATABASE_URL);
    store = pgStore;
    setStoreModule(store); // Also swap the API's store
    console.error("[Server] Using Postgres store");
}
else {
    store = await import("./store.js");
    console.error("[Server] Using file-based store");
}
// --- Config ---
const PORT = parseInt(process.env.PORT || "3456", 10);
const RELAY_PORT = parseInt(process.env.RELAY_PORT || "7862", 10);
let actualRelayPort = RELAY_PORT; // tracks the port the relay is actually listening on
// Shared secret between the managed backend and the relay.
// Only clients registering with this secret can route to managed sessions.
import { randomBytes, timingSafeEqual } from "crypto";
const RELAY_INTERNAL_SECRET = process.env.RELAY_SECRET || randomBytes(32).toString("hex");
if (!process.env.RELAY_SECRET && process.env.NODE_ENV === "production") {
    console.error("[Server] WARNING: RELAY_SECRET not set — generated a random secret. Set RELAY_SECRET env var for stable deployments.");
}
const relayClients = new Map();
const extensionQueue = [];
// --- Managed session routing ---
/** Find the relay client for a specific browser session */
function getSessionClient(browserSessionId) {
    for (const c of relayClients.values()) {
        if (c.browserSessionId === browserSessionId && c.ws.readyState === WebSocket.OPEN) {
            return c;
        }
    }
    return null;
}
/** Check if a browser session is connected */
export function isSessionConnected(browserSessionId) {
    return getSessionClient(browserSessionId) !== null;
}
// --- Legacy BYOM routing ---
function getLegacyExtension() {
    for (const c of relayClients.values()) {
        if (c.role === "extension" && !c.browserSessionId)
            return c;
    }
    return null;
}
// --- Relay Limits ---
const RELAY_MAX_MESSAGE_BYTES = 5 * 1024 * 1024; // 5 MB max message (screenshots can be large)
const RELAY_MAX_CONNECTIONS = 100; // max simultaneous WebSocket connections
function startRelay() {
    // In production, bind to loopback — Caddy reverse-proxies from the internet.
    // Set RELAY_HOST=0.0.0.0 for local dev without a reverse proxy.
    const RELAY_HOST = process.env.RELAY_HOST || (process.env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0");
    return new Promise((resolve, reject) => {
        function tryPort(port) {
            const wss = new WebSocketServer({
                port,
                host: RELAY_HOST,
                maxPayload: RELAY_MAX_MESSAGE_BYTES,
            });
            wss.on("listening", () => {
                actualRelayPort = port;
                console.error(`[Relay] Listening on ws://${RELAY_HOST}:${port} (max ${RELAY_MAX_CONNECTIONS} connections, max ${RELAY_MAX_MESSAGE_BYTES / 1024 / 1024}MB/msg)`);
                setupRelayHandlers(wss);
                resolve();
            });
            wss.on("error", (err) => {
                if (err.code === "EADDRINUSE") {
                    if (port < RELAY_PORT + 3) {
                        console.error(`[Relay] Port ${port} in use — trying ${port + 1}`);
                        tryPort(port + 1);
                    }
                    else {
                        console.error(`[Relay] Ports ${RELAY_PORT}-${port} all in use — relay not started`);
                        reject(new Error("All relay ports in use"));
                    }
                    return;
                }
                console.error(`[Relay] Error: ${err.message}`);
                reject(err);
            });
        }
        tryPort(RELAY_PORT);
    });
}
function setupRelayHandlers(wss) {
    wss.on("connection", (ws) => {
        // Enforce max connections
        if (wss.clients.size > RELAY_MAX_CONNECTIONS) {
            ws.close(1013, "Server too busy — max connections reached");
            console.error(`[Relay] Rejected connection: max ${RELAY_MAX_CONNECTIONS} connections exceeded`);
            return;
        }
        ws.on("message", async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                // --- Registration ---
                if (msg.type === "register") {
                    // Check for managed session token auth
                    if (msg.session_token) {
                        const session = await store.validateSessionToken(msg.session_token);
                        if (!session) {
                            ws.send(JSON.stringify({ type: "error", error: "Invalid session token" }));
                            ws.close();
                            return;
                        }
                        const client = {
                            ws,
                            role: "extension",
                            clientId: randomUUID(),
                            browserSessionId: session.id,
                            isInternalBackend: false,
                        };
                        relayClients.set(ws, client);
                        store.heartbeatSession(session.id);
                        ws.send(JSON.stringify({
                            type: "registered",
                            clientId: client.clientId,
                            role: "extension",
                            browserSessionId: session.id,
                        }));
                        console.error(`[Relay] Managed session registered: ${session.id}`);
                        return;
                    }
                    // Check relay_secret for internal backend auth
                    let isInternal = false;
                    if (typeof msg.relay_secret === "string" && msg.relay_secret.length === RELAY_INTERNAL_SECRET.length) {
                        try {
                            isInternal = timingSafeEqual(Buffer.from(msg.relay_secret), Buffer.from(RELAY_INTERNAL_SECRET));
                        }
                        catch {
                            isInternal = false;
                        }
                    }
                    // In production, reject unauthenticated legacy registrations.
                    // Only the internal backend (with relay_secret) and managed sessions (with session_token) can connect.
                    if (process.env.NODE_ENV === "production" && !isInternal) {
                        ws.send(JSON.stringify({ type: "error", error: "Legacy relay mode disabled in production. Use session_token auth." }));
                        ws.close();
                        return;
                    }
                    const client = {
                        ws,
                        role: msg.role || "cli",
                        clientId: randomUUID(),
                        isInternalBackend: isInternal,
                    };
                    relayClients.set(ws, client);
                    ws.send(JSON.stringify({ type: "registered", clientId: client.clientId, role: client.role }));
                    console.error(`[Relay] ${isInternal ? "Internal backend" : "Legacy"} registered: ${client.role} (${client.clientId})`);
                    // Flush queue to legacy extension
                    if (client.role === "extension" && extensionQueue.length > 0) {
                        for (const queued of extensionQueue) {
                            ws.send(queued);
                        }
                        extensionQueue.length = 0;
                    }
                    return;
                }
                // Ping/pong — client-initiated heartbeat
                if (msg.type === "ping") {
                    // Heartbeat for managed sessions — enforces expiry/revocation
                    const sender = relayClients.get(ws);
                    if (sender?.browserSessionId) {
                        const valid = await store.heartbeatSession(sender.browserSessionId);
                        if (!valid) {
                            ws.send(JSON.stringify({ type: "error", error: "Session expired or revoked" }));
                            ws.close();
                            return;
                        }
                    }
                    // No token rotation here — rotation is driven solely by the server-initiated
                    // keepalive pings (below) to avoid double-rotation races.
                    ws.send(JSON.stringify({ type: "pong" }));
                    return;
                }
                const sender = relayClients.get(ws);
                if (!sender)
                    return;
                if (msg.type === "proxy_api_call" && sender.role === "extension") {
                    await handleApiProxy(ws, msg, (message) => console.error(`[Relay] ${message}`));
                    return;
                }
                // Match standalone relay behavior for onboarding / credential import flows.
                if (msg.type === "status_query") {
                    const ext = getLegacyExtension();
                    ws.send(JSON.stringify({
                        type: "status_response",
                        requestId: msg.requestId,
                        extensionConnected: !!ext && ext.ws.readyState === WebSocket.OPEN,
                    }));
                    return;
                }
                if (msg.type === "read_credentials" && sender.role === "extension") {
                    const { credentialType } = msg;
                    try {
                        if (credentialType === "claude") {
                            const creds = getClaudeCredentials() || getClaudeKeychainCredentials();
                            if (creds) {
                                ws.send(JSON.stringify({
                                    type: "credentials_result",
                                    requestId: msg.requestId,
                                    credentialType: "claude",
                                    credentials: {
                                        accessToken: creds.accessToken,
                                        refreshToken: creds.refreshToken,
                                        expiresAt: creds.expiresAt,
                                    },
                                }));
                            }
                            else {
                                ws.send(JSON.stringify({
                                    type: "credentials_result",
                                    requestId: msg.requestId,
                                    credentialType: "claude",
                                    error: "Claude credentials not found. Run `claude login` first.",
                                }));
                            }
                        }
                        else if (credentialType === "codex") {
                            const creds = getCodexCredentials();
                            if (creds) {
                                ws.send(JSON.stringify({
                                    type: "credentials_result",
                                    requestId: msg.requestId,
                                    credentialType: "codex",
                                    credentials: {
                                        accessToken: creds.accessToken,
                                        refreshToken: creds.refreshToken,
                                        accountId: creds.accountId,
                                    },
                                }));
                            }
                            else {
                                ws.send(JSON.stringify({
                                    type: "credentials_result",
                                    requestId: msg.requestId,
                                    credentialType: "codex",
                                    error: "Codex credentials not found. Run `codex auth login` first.",
                                }));
                            }
                        }
                        else {
                            ws.send(JSON.stringify({
                                type: "credentials_result",
                                requestId: msg.requestId,
                                error: `Unknown credential type: ${credentialType}`,
                            }));
                        }
                    }
                    catch (err) {
                        ws.send(JSON.stringify({
                            type: "credentials_result",
                            requestId: msg.requestId,
                            error: err.message,
                        }));
                    }
                    return;
                }
                // --- Managed routing: route by targetSessionId ---
                // SECURITY: Only the internal managed backend (authenticated with relay_secret)
                // can route to managed sessions. Self-declared roles are NOT trusted.
                if (msg.targetSessionId) {
                    if (!sender.isInternalBackend) {
                        ws.send(JSON.stringify({
                            type: "error",
                            requestId: msg.requestId,
                            error: "Unauthorized: only the managed backend can route to browser sessions",
                        }));
                        return;
                    }
                    const target = getSessionClient(msg.targetSessionId);
                    if (target) {
                        msg.sourceClientId = sender.clientId;
                        target.ws.send(JSON.stringify(msg));
                    }
                    else {
                        ws.send(JSON.stringify({
                            type: "tool_result",
                            requestId: msg.requestId,
                            error: `Browser session ${msg.targetSessionId} is not connected`,
                        }));
                    }
                    return;
                }
                // --- Legacy routing (BYOM Local) ---
                if (sender.role === "extension" || sender.browserSessionId) {
                    // Extension → route to specific MCP/CLI client or broadcast
                    const targetId = msg.sourceClientId;
                    if (targetId) {
                        for (const c of relayClients.values()) {
                            if (c.clientId === targetId && c.ws.readyState === WebSocket.OPEN) {
                                c.ws.send(JSON.stringify(msg));
                                return;
                            }
                        }
                    }
                    for (const c of relayClients.values()) {
                        if (c.role !== "extension" && !c.browserSessionId && c.ws.readyState === WebSocket.OPEN) {
                            c.ws.send(JSON.stringify(msg));
                        }
                    }
                }
                else {
                    // MCP/CLI → route to legacy extension
                    const ext = getLegacyExtension();
                    if (ext && ext.ws.readyState === WebSocket.OPEN) {
                        msg.sourceClientId = sender.clientId;
                        ext.ws.send(JSON.stringify(msg));
                    }
                    else {
                        extensionQueue.push(JSON.stringify(msg));
                        if (extensionQueue.length > 50)
                            extensionQueue.shift();
                    }
                }
            }
            catch (e) {
                console.error("[Relay] Parse error:", e);
            }
        });
        ws.on("close", () => {
            const client = relayClients.get(ws);
            if (client) {
                if (client.browserSessionId) {
                    store.disconnectSession(client.browserSessionId);
                    // Immediately fail any pending tool executions for this session
                    // so the agent loop doesn't wait for timeout on each one.
                    onSessionDisconnected(client.browserSessionId);
                    console.error(`[Relay] Managed session disconnected: ${client.browserSessionId}`);
                }
                else {
                    console.error(`[Relay] Legacy disconnected: ${client.role}`);
                }
                relayClients.delete(ws);
            }
        });
    });
    // Keepalive pings to extensions — keeps Chrome MV3 service workers alive
    // (they sleep after ~30s of inactivity, dropping the WebSocket).
    // Also drives heartbeat and token rotation for managed sessions.
    setInterval(async () => {
        for (const [ws, client] of relayClients) {
            if (client.role !== "extension" || ws.readyState !== WebSocket.OPEN)
                continue;
            const pingPayload = { type: "ping" };
            if (client.browserSessionId) {
                // Heartbeat + expiry check
                const valid = await store.heartbeatSession(client.browserSessionId);
                if (!valid) {
                    ws.send(JSON.stringify({ type: "error", error: "Session expired or revoked" }));
                    ws.close();
                    continue;
                }
                // Token rotation: every ~10 minutes (every 30th ping at 20s intervals)
                client._heartbeatCount = (client._heartbeatCount || 0) + 1;
                if (client._heartbeatCount % 30 === 0) {
                    const newToken = await store.rotateSessionToken(client.browserSessionId);
                    if (newToken) {
                        pingPayload.new_session_token = newToken;
                        console.error(`[Relay] Rotated token for session ${client.browserSessionId}`);
                    }
                }
            }
            ws.send(JSON.stringify(pingPayload));
        }
    }, 20_000);
}
// --- Main ---
async function main() {
    initManagedTelemetry();
    // 1. Init Vertex AI (optional — managed task execution disabled without it)
    const saJson = process.env.VERTEX_SA_JSON;
    const saPath = process.env.VERTEX_SA_PATH;
    if (saJson) {
        initVertex(JSON.parse(saJson));
    }
    else if (saPath) {
        try {
            initVertex(saPath);
        }
        catch (err) {
            console.error(`[Server] Vertex AI disabled: ${err.message}`);
            console.error("[Server] Managed task execution won't work. Set VERTEX_SA_PATH to enable it.");
        }
    }
    else {
        console.error("[Server] Vertex AI not configured (no VERTEX_SA_PATH or VERTEX_SA_JSON).");
        console.error("[Server] BYOM + dashboard + API work fine. Managed task execution disabled.");
    }
    // 2. Bootstrap workspace + API key
    // In production, warn that auto-bootstrap is a convenience, not long-term behavior.
    const { workspace, apiKey } = await store.ensureDefaultWorkspace();
    const keyDisplay = apiKey.key.startsWith("hic_live_") ? apiKey.key.slice(0, 20) + "..." : "(existing)";
    if (process.env.NODE_ENV === "production") {
        console.error(`[Server] WARNING: Auto-bootstrapped default workspace. Use explicit workspace provisioning for multi-tenant.`);
    }
    console.error(`[Server] Workspace: ${workspace.id}, API key: ${keyDisplay}`);
    // 3. Start relay (waits until listening)
    await startRelay();
    // 4. Connect to relay as internal client
    const relay = new WebSocketClient({
        role: "mcp",
        relayUrl: `ws://127.0.0.1:${actualRelayPort}`,
        autoStartRelay: false,
        registerExtra: { relay_secret: RELAY_INTERNAL_SECRET },
    });
    relay.onMessage((message) => {
        if (handleRelayMessage(message))
            return;
        if (message?.type === "pong" || message?.type === "registered")
            return;
    });
    // Connect with timeout — if relay fails to start, exit instead of hanging forever
    const connectTimeout = setTimeout(() => {
        console.error("[Server] FATAL: Relay connection timed out after 10s");
        process.exit(1);
    }, 10_000);
    await relay.connect();
    clearTimeout(connectTimeout);
    // 5. Init billing (optional — works without Stripe credentials)
    initBilling();
    setBillingStore(store);
    // 6. Start API — pass session connectivity checker
    initManagedAPI(relay, isSessionConnected, actualRelayPort);
    startManagedAPI(PORT);
    store.startHeartbeatFlush();
    // 7. Recover tasks stuck in "running" from a previous process
    await recoverStuckTasks();
    // 8. Start scheduler for automated tasks
    if (DATABASE_URL) {
        const pgStore = await import("./store-pg.js");
        initScheduler({
            store: pgStore,
            runTask: runInternalTask,
            isSessionConnected: isSessionConnected,
            notify: notifyDraftsReady,
        });
        startScheduler();
    }
    console.error(`
╔════════════════════════════════════════════════╗
║  Hanzi Managed Backend (deployed)              ║
║                                                ║
║  API:     http://${process.env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0"}:${String(PORT).padEnd(5)}              ║
║  Relay:   ws://${process.env.NODE_ENV === "production" ? "127.0.0.1" : "0.0.0.0"}:${String(actualRelayPort).padEnd(5)}               ║
║  LLM:     Vertex AI (Gemini 2.5 Flash)         ║
║  Key:     ${keyDisplay.padEnd(33)} ║
╚════════════════════════════════════════════════╝
`);
}
main().catch((err) => {
    console.error("[Server] Fatal:", err);
    process.exit(1);
});
// --- Graceful Shutdown ---
// On SIGTERM/SIGINT, abort running tasks with clean status updates
// before the process exits. Without this, tasks stay in "running" state
// permanently in the database.
async function handleShutdown(signal) {
    console.error(`\n[Server] Received ${signal} — shutting down gracefully...`);
    try {
        stopScheduler();
        await shutdownManagedAPI();
        await shutdownManagedTelemetry();
    }
    catch (err) {
        console.error(`[Server] Shutdown error:`, err.message);
    }
    process.exit(0);
}
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));
