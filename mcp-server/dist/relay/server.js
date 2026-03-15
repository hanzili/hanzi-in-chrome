#!/usr/bin/env node
/**
 * WebSocket Relay Server
 *
 * Stateless message router between extension, MCP server, and CLI.
 * Replaces file-based IPC with real-time WebSocket communication.
 *
 * Roles:
 *   - extension: Chrome extension service worker (one at a time)
 *   - mcp: MCP server (can have multiple)
 *   - cli: CLI clients (can have multiple)
 *
 * Routing:
 *   - extension → originating mcp/cli client when tagged, otherwise broadcast
 *   - mcp/cli → send to extension
 */
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { getClaudeCredentials, getClaudeKeychainCredentials, getCodexCredentials, refreshClaudeToken, saveClaudeCredentials, } from '../llm/credentials.js';
const DEFAULT_PORT = 7862;
const port = parseInt(process.env.WS_RELAY_PORT || String(DEFAULT_PORT), 10);
const clients = new Map();
// Queue messages for extension when it's disconnected (service worker sleeping)
const extensionQueue = [];
const MAX_QUEUE_SIZE = 50;
const QUEUE_MAX_AGE_MS = 60000; // Drop queued messages older than 60s
const queueTimestamps = [];
function log(msg) {
    console.error(`[Relay] ${msg}`);
}
function getClientsByRole(role) {
    return Array.from(clients.values()).filter(c => c.role === role);
}
function getExtension() {
    return getClientsByRole('extension')[0];
}
function sendToConsumers(message, targetClientId, exclude) {
    for (const [ws, client] of clients) {
        const isConsumer = client.role === 'mcp' || client.role === 'cli';
        const matchesTarget = !targetClientId || client.clientId === targetClientId;
        if (ws !== exclude && ws.readyState === WebSocket.OPEN && isConsumer && matchesTarget) {
            ws.send(message);
        }
    }
}
function sendToExtension(message) {
    const ext = getExtension();
    if (ext && ext.ws.readyState === WebSocket.OPEN) {
        ext.ws.send(message);
        return true;
    }
    // Extension not connected — queue the message for delivery on reconnect
    // Deduplicate start_task by sessionId: if a start_task for the same session
    // is already queued, replace it instead of adding a duplicate.
    try {
        const parsed = JSON.parse(message);
        if (parsed.type === 'mcp_start_task' && parsed.sessionId) {
            for (let i = 0; i < extensionQueue.length; i++) {
                try {
                    const queued = JSON.parse(extensionQueue[i]);
                    if (queued.type === 'mcp_start_task' && queued.sessionId === parsed.sessionId) {
                        log(`Deduplicating queued start_task for session ${parsed.sessionId}`);
                        extensionQueue[i] = message;
                        queueTimestamps[i] = Date.now();
                        return true;
                    }
                }
                catch { /* skip malformed */ }
            }
        }
    }
    catch { /* not JSON, queue as-is */ }
    if (extensionQueue.length >= MAX_QUEUE_SIZE) {
        extensionQueue.shift();
        queueTimestamps.shift();
    }
    extensionQueue.push(message);
    queueTimestamps.push(Date.now());
    log(`Extension offline, queued message (${extensionQueue.length} pending)`);
    return true; // Return true — message is queued, not lost
}
function flushExtensionQueue(ext) {
    if (extensionQueue.length === 0)
        return;
    const now = Date.now();
    let delivered = 0;
    let expired = 0;
    while (extensionQueue.length > 0) {
        const msg = extensionQueue.shift();
        const ts = queueTimestamps.shift();
        if (now - ts > QUEUE_MAX_AGE_MS) {
            expired++;
            continue;
        }
        ext.ws.send(msg);
        delivered++;
    }
    log(`Flushed queue: ${delivered} delivered, ${expired} expired`);
}
const wss = new WebSocketServer({ port }, () => {
    log(`Listening on ws://localhost:${port}`);
});
wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        log(`Port ${port} already in use — another relay is running. Exiting.`);
        process.exit(0);
    }
    log(`Server error: ${err.message}`);
    process.exit(1);
});
wss.on('connection', (ws) => {
    log(`New connection (${clients.size + 1} total)`);
    ws.on('message', (data) => {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        }
        catch {
            log('Invalid JSON received, ignoring');
            return;
        }
        // Handle registration
        if (msg.type === 'register') {
            const role = msg.role;
            if (!['extension', 'mcp', 'cli'].includes(role)) {
                ws.send(JSON.stringify({ type: 'error', error: `Invalid role: ${role}` }));
                return;
            }
            // If a new extension registers, disconnect old one
            if (role === 'extension') {
                const existing = getExtension();
                if (existing && existing.ws !== ws) {
                    log('New extension connecting, closing old one');
                    existing.ws.close(1000, 'replaced');
                    clients.delete(existing.ws);
                }
            }
            clients.set(ws, {
                ws,
                role,
                clientId: randomUUID().slice(0, 8),
                sessionId: msg.sessionId,
                registeredAt: Date.now(),
            });
            ws.send(JSON.stringify({ type: 'registered', role, clientId: clients.get(ws).clientId }));
            log(`Client registered as ${role} (${clients.size} total)`);
            // Deliver any queued messages to the extension
            if (role === 'extension') {
                flushExtensionQueue(clients.get(ws));
            }
            return;
        }
        // Route messages based on sender role
        const client = clients.get(ws);
        if (!client) {
            // Unregistered client — require registration first
            ws.send(JSON.stringify({ type: 'error', error: 'Must register first' }));
            return;
        }
        // Handle status_query — relay answers directly (no round trip to extension)
        if (msg.type === 'status_query') {
            const ext = getExtension();
            ws.send(JSON.stringify({
                type: 'status_response',
                requestId: msg.requestId,
                extensionConnected: !!ext && ext.ws.readyState === WebSocket.OPEN,
            }));
            return;
        }
        // Handle read_credentials — relay reads from filesystem (replaces native host)
        if (msg.type === 'read_credentials' && client.role === 'extension') {
            const { credentialType } = msg;
            try {
                if (credentialType === 'claude') {
                    const creds = getClaudeCredentials() || getClaudeKeychainCredentials();
                    if (creds) {
                        ws.send(JSON.stringify({
                            type: 'credentials_result',
                            requestId: msg.requestId,
                            credentialType: 'claude',
                            credentials: {
                                accessToken: creds.accessToken,
                                refreshToken: creds.refreshToken,
                                expiresAt: creds.expiresAt,
                            },
                        }));
                    }
                    else {
                        ws.send(JSON.stringify({
                            type: 'credentials_result',
                            requestId: msg.requestId,
                            credentialType: 'claude',
                            error: 'Claude credentials not found. Run `claude login` first.',
                        }));
                    }
                }
                else if (credentialType === 'codex') {
                    const creds = getCodexCredentials();
                    if (creds) {
                        ws.send(JSON.stringify({
                            type: 'credentials_result',
                            requestId: msg.requestId,
                            credentialType: 'codex',
                            credentials: {
                                accessToken: creds.accessToken,
                                refreshToken: creds.refreshToken,
                                accountId: creds.accountId,
                            },
                        }));
                    }
                    else {
                        ws.send(JSON.stringify({
                            type: 'credentials_result',
                            requestId: msg.requestId,
                            credentialType: 'codex',
                            error: 'Codex credentials not found. Run `codex auth login` first.',
                        }));
                    }
                }
                else {
                    ws.send(JSON.stringify({
                        type: 'credentials_result',
                        requestId: msg.requestId,
                        error: `Unknown credential type: ${credentialType}`,
                    }));
                }
            }
            catch (err) {
                ws.send(JSON.stringify({
                    type: 'credentials_result',
                    requestId: msg.requestId,
                    error: err.message,
                }));
            }
            return;
        }
        // Handle proxy_api_call — relay proxies API calls with impersonation headers
        if (msg.type === 'proxy_api_call' && client.role === 'extension') {
            handleApiProxy(ws, msg);
            return;
        }
        const raw = data.toString();
        if (client.role === 'extension') {
            // Extension → originating MCP/CLI client when known, otherwise broadcast
            sendToConsumers(raw, typeof msg.sourceClientId === 'string' ? msg.sourceClientId : undefined);
        }
        else {
            // MCP/CLI → send to extension (queued if offline)
            sendToExtension(JSON.stringify({ ...msg, sourceClientId: client.clientId }));
        }
    });
    ws.on('close', () => {
        const client = clients.get(ws);
        if (client) {
            log(`${client.role} disconnected (${clients.size - 1} remaining)`);
            clients.delete(ws);
        }
    });
    ws.on('error', (err) => {
        log(`WebSocket error: ${err.message}`);
    });
});
/**
 * Proxy API calls with Claude Code impersonation headers.
 * Reads OAuth token, makes the API call, streams SSE events back to extension.
 */
async function handleApiProxy(ws, msg) {
    const { requestId, url, body } = msg;
    const PROXY_TIMEOUT_MS = 150000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    const EXPIRY_BUFFER_MS = 60 * 1000;
    const getFreshClaudeCredentials = async () => {
        const existing = getClaudeCredentials() || getClaudeKeychainCredentials();
        if (!existing) {
            return null;
        }
        if (existing.expiresAt && existing.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
            return existing;
        }
        log('Claude OAuth token expired or near expiry, refreshing before proxy call');
        const refreshed = await refreshClaudeToken(existing.refreshToken);
        saveClaudeCredentials(refreshed);
        return refreshed;
    };
    try {
        // Read OAuth credentials
        let creds = await getFreshClaudeCredentials();
        if (!creds) {
            ws.send(JSON.stringify({ type: 'proxy_api_error', requestId, error: 'No Claude credentials found' }));
            return;
        }
        // Claude Code impersonation headers
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${creds.accessToken}`,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
            'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14',
            'x-app': 'cli',
            'user-agent': 'claude-code/2.1.29 (Darwin; arm64)',
        };
        let response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
        if (response.status === 401) {
            log('Claude proxy request got 401, refreshing token and retrying once');
            const refreshed = await refreshClaudeToken(creds.refreshToken);
            saveClaudeCredentials(refreshed);
            creds = refreshed;
            headers.Authorization = `Bearer ${creds.accessToken}`;
            response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
        }
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            clearTimeout(timeoutId);
            ws.send(JSON.stringify({
                type: 'proxy_api_error',
                requestId,
                error: `API error: ${response.status} - ${errorText.slice(0, 500)}`,
            }));
            return;
        }
        // Parse SSE stream and forward events to extension
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: '))
                    continue;
                const data = line.slice(6);
                if (data === '[DONE]')
                    continue;
                try {
                    const event = JSON.parse(data);
                    // Forward each SSE event to extension
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'proxy_stream_chunk',
                            requestId,
                            data: event,
                        }));
                    }
                }
                catch {
                    // Skip malformed JSON
                }
            }
        }
        clearTimeout(timeoutId);
        // Signal stream complete
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'proxy_stream_end', requestId }));
        }
    }
    catch (err) {
        clearTimeout(timeoutId);
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'proxy_api_error',
                requestId,
                error: err.name === 'AbortError'
                    ? `API proxy request timed out after ${PROXY_TIMEOUT_MS / 1000} seconds`
                    : err.message,
            }));
        }
    }
}
// Graceful shutdown
process.on('SIGINT', () => {
    log('Shutting down...');
    wss.close();
    process.exit(0);
});
process.on('SIGTERM', () => {
    log('Shutting down...');
    wss.close();
    process.exit(0);
});
// Keep alive — log stats periodically
setInterval(() => {
    const roles = { extension: 0, mcp: 0, cli: 0 };
    for (const client of clients.values()) {
        roles[client.role]++;
    }
    if (clients.size > 0) {
        log(`Clients: ${clients.size} (ext:${roles.extension} mcp:${roles.mcp} cli:${roles.cli})`);
    }
}, 30000);
