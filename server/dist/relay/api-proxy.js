import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { getClaudeCredentials, getClaudeKeychainCredentials, getCodexCredentials, refreshClaudeToken, saveClaudeCredentials, } from '../llm/credentials.js';
const PROXY_TIMEOUT_MS = 150000;
const EXPIRY_BUFFER_MS = 60 * 1000;
function defaultLogger(message) {
    console.error(`[Relay] ${message}`);
}
function isCodexUrl(hostname) {
    return hostname.includes('chatgpt.com') || hostname.includes('openai.com');
}
function buildCodexHeaders(accountId, accessToken) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'openai-beta': 'responses=experimental',
        'chatgpt-account-id': accountId || '',
        'session_id': randomUUID(),
        'conversation_id': randomUUID(),
        'user-agent': 'codex_cli_rs/0.34.0 (Darwin; arm64)',
        'originator': 'codex_cli_rs',
        'accept': 'text/event-stream',
    };
}
async function getFreshClaudeCredentials(log) {
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
}
async function sendProxyStream(ws, requestId, response, options = {}) {
    const { endOnCompleted = false } = options;
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
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'proxy_stream_chunk',
                        requestId,
                        data: event,
                    }));
                }
                if (endOnCompleted && event.type === 'response.completed') {
                    try {
                        await reader.cancel();
                    }
                    catch {
                        // Ignore cancellation errors after terminal response event.
                    }
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'proxy_stream_end', requestId }));
                    }
                    return;
                }
            }
            catch {
                // Skip malformed JSON chunks.
            }
        }
    }
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'proxy_stream_end', requestId }));
    }
}
export async function handleApiProxy(ws, msg, log = defaultLogger) {
    const { requestId, url, body } = msg;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
        const urlObj = new URL(url);
        const isCodex = isCodexUrl(urlObj.hostname);
        let headers;
        if (isCodex) {
            const creds = getCodexCredentials();
            if (!creds?.accessToken) {
                ws.send(JSON.stringify({ type: 'proxy_api_error', requestId, error: 'No Codex credentials found. Run `codex auth login` first.' }));
                return;
            }
            headers = buildCodexHeaders(creds.accountId, creds.accessToken);
        }
        else {
            let creds = await getFreshClaudeCredentials(log);
            if (!creds) {
                ws.send(JSON.stringify({ type: 'proxy_api_error', requestId, error: 'No Claude credentials found' }));
                return;
            }
            headers = {
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
                ws.send(JSON.stringify({
                    type: 'proxy_api_error',
                    requestId,
                    error: `API error: ${response.status} - ${errorText.slice(0, 500)}`,
                }));
                return;
            }
            await sendProxyStream(ws, requestId, response);
            return;
        }
        const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
        if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            ws.send(JSON.stringify({
                type: 'proxy_api_error',
                requestId,
                error: `API error: ${response.status} - ${errorText.slice(0, 500)}`,
            }));
            return;
        }
        await sendProxyStream(ws, requestId, response, { endOnCompleted: true });
    }
    catch (err) {
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
    finally {
        clearTimeout(timeoutId);
    }
}
