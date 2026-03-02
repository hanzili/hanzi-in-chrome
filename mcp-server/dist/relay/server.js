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
 *   - extension → broadcast to all mcp + cli clients
 *   - mcp/cli → send to extension
 */
import { WebSocketServer, WebSocket } from 'ws';
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
function broadcast(message, exclude) {
    for (const [ws, client] of clients) {
        if (ws !== exclude && ws.readyState === WebSocket.OPEN) {
            ws.send(message);
        }
    }
}
function sendToConsumers(message, exclude) {
    for (const [ws, client] of clients) {
        if (ws !== exclude && ws.readyState === WebSocket.OPEN &&
            (client.role === 'mcp' || client.role === 'cli')) {
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
                sessionId: msg.sessionId,
                registeredAt: Date.now(),
            });
            ws.send(JSON.stringify({ type: 'registered', role }));
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
                extensionConnected: !!ext && ext.ws.readyState === WebSocket.OPEN,
            }));
            return;
        }
        const raw = data.toString();
        if (client.role === 'extension') {
            // Extension → broadcast to all MCP + CLI consumers
            sendToConsumers(raw);
        }
        else {
            // MCP/CLI → send to extension (queued if offline)
            sendToExtension(raw);
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
