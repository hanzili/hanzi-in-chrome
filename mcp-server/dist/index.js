#!/usr/bin/env node
/**
 * Hanzi in Chrome MCP Server
 *
 * Simple browser automation: send a task, get back the result.
 * The browser agent in the Chrome extension handles everything autonomously.
 *
 * browser_start blocks until the task completes — no polling needed.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketClient } from "./ipc/websocket-client.js";
import { randomUUID } from "crypto";
import { exec } from "child_process";
const sessions = new Map();
const pendingScreenshots = new Map();
// Max time a task can run before we return (configurable, default 10 minutes)
// On timeout, MCP returns an error but the browser window stays open.
// Claude Code can then use browser_message to continue or browser_stop to clean up.
const TASK_TIMEOUT_MS = parseInt(process.env.HANZI_IN_CHROME_TIMEOUT_MS || String(5 * 60 * 1000), 10);
const MAX_CONCURRENT = parseInt(process.env.HANZI_IN_CHROME_MAX_SESSIONS || "5", 10);
const LICENSE_KEY = process.env.HANZI_IN_CHROME_LICENSE_KEY || undefined;
// WebSocket relay connection
let connection;
// --- Message handling ---
async function handleMessage(message) {
    const { type, sessionId, results, ...data } = message;
    // Handle get_info requests from extension — return raw context
    if (type === "mcp_get_info") {
        const session = sessions.get(sessionId);
        const response = session?.context
            ? `Here is the context:\n${session.context}`
            : `No context available. Check <system-reminder> tags in your conversation.`;
        await send({ type: "mcp_get_info_response", sessionId, requestId: data.requestId, response });
        return;
    }
    // Handle escalation — agent is pausing to ask the caller a question
    if (type === "mcp_escalate") {
        const session = sessions.get(sessionId);
        if (session && session.status === "running") {
            session.status = "waiting";
            session.question = data.whatINeed || data.problem || "The browser agent needs your input.";
            session.escalateRequestId = data.requestId;
            console.error(`[MCP] Session ${sessionId} waiting: ${session.question}`);
            session.resolve?.();
        }
        return;
    }
    // Handle batch results from polling
    if (type === "mcp_results" && Array.isArray(results)) {
        for (const result of results)
            processResult(result);
        return;
    }
    // Handle single result
    if (sessionId) {
        processResult({ type, sessionId, ...data });
    }
}
function processResult(result) {
    const { type, sessionId, ...data } = result;
    // Handle screenshots for pending requests (not real sessions)
    if (type === "screenshot" && data.data && sessionId) {
        const pending = pendingScreenshots.get(sessionId);
        if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve(data.data);
            pendingScreenshots.delete(sessionId);
            return;
        }
    }
    const session = sessions.get(sessionId);
    if (!session)
        return;
    const step = data.step || data.status || data.message;
    switch (type) {
        case "task_update":
            if (step && step !== "thinking" && !step.startsWith("[thinking]")) {
                session.steps.push(step);
            }
            break;
        case "task_complete":
            session.status = "complete";
            session.answer = step || session.steps[session.steps.length - 1];
            console.error(`[MCP] Session ${sessionId} complete`);
            session.resolve?.();
            break;
        case "task_error":
            session.status = "error";
            session.error = data.error || "Unknown error";
            console.error(`[MCP] Session ${sessionId} error: ${session.error}`);
            session.resolve?.();
            break;
        case "screenshot":
            if (data.data) {
                const pending = pendingScreenshots.get(sessionId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    pending.resolve(data.data);
                    pendingScreenshots.delete(sessionId);
                }
            }
            break;
    }
}
async function send(message) {
    await connection.send(message);
}
/**
 * Wait for a session to reach a terminal state (complete or error).
 *
 * IMPORTANT: Clears any previous timeout before setting a new one.
 * Without this, a stale timeout from browser_start can fire during
 * browser_message — corrupting the session status and causing the
 * browser_message promise to hang forever.
 */
function waitForSession(session) {
    if (session.status !== "running")
        return Promise.resolve();
    // Clear any stale timeout from a previous waitForSession call
    // (e.g., browser_start timeout still pending when browser_message is called)
    if (session.timeoutId) {
        clearTimeout(session.timeoutId);
        session.timeoutId = undefined;
    }
    return new Promise((resolve) => {
        session.resolve = resolve;
        // Safety timeout — stop the agent but leave the browser window open
        session.timeoutId = setTimeout(() => {
            session.timeoutId = undefined;
            if (session.status === "running") {
                session.status = "timeout";
                session.error = `Task still running after ${TASK_TIMEOUT_MS / 60000} minutes. Use browser_screenshot to check progress, then browser_message to continue or browser_stop to end.`;
                resolve();
            }
        }, TASK_TIMEOUT_MS);
    });
}
function formatResult(session) {
    const result = {
        session_id: session.id,
        status: session.status,
        task: session.task,
    };
    if (session.answer)
        result.answer = session.answer;
    if (session.error)
        result.error = session.error;
    if (session.question && session.status === "waiting")
        result.question = session.question;
    if (session.steps.length > 0) {
        result.total_steps = session.steps.length;
        result.recent_steps = session.steps.slice(-5);
    }
    return result;
}
// --- Helpers ---
const EXTENSION_URL = "https://chromewebstore.google.com/detail/hanzi-in-chrome/iklpkemlmbhemkiojndpbhoakgikpmcd";
function openInBrowser(url) {
    const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
    exec(`${cmd} "${url}"`);
}
// --- Extension connectivity check ---
async function isExtensionConnected() {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            connection.offMessage(handler);
            resolve(false);
        }, 2000);
        const handler = (msg) => {
            if (msg.type === "status_response") {
                clearTimeout(timeout);
                connection.offMessage(handler);
                resolve(msg.extensionConnected === true);
            }
        };
        connection.onMessage(handler);
        connection.send({ type: "status_query" }).catch(() => resolve(false));
    });
}
// --- Tool definitions ---
const TOOLS = [
    {
        name: "browser_start",
        description: `Start a browser automation task. Controls the user's real Chrome browser with their existing logins, cookies, and sessions.

An autonomous agent navigates, clicks, types, and fills forms. Blocks until complete or timeout (5 min). You can run multiple browser_start calls in parallel — each gets its own browser window.

WHEN TO USE — only when you need a real browser and no other tool can do it:
- Clicking, typing, filling forms, navigating menus, selecting dropdowns
- Testing workflows: "sign up for an account and verify the welcome email arrives"
- Posting or publishing: write a LinkedIn post, send a Slack message, submit a forum reply, post a tweet
- Authenticated pages: read a Jira ticket, check GitHub PR status, pull data from an analytics dashboard, check order status — the user is already logged in
- Dynamic / JS-rendered pages: SPAs, dashboards, infinite scroll — content that plain fetch can't reach
- Multi-step tasks: "find flights from A to B, compare prices, and pick the cheapest"

WHEN NOT TO USE — always prefer faster tools first:
- If you have an API, MCP tool, or CLI command that can accomplish the task, use that instead. Browser automation is slower and should be a last resort.
- Factual or general knowledge questions — just answer directly
- Web search — use built-in web search or a search MCP
- Reading public/static pages — use a fetch, reader, or web scraping tool
- GitHub, Jira, Slack, etc. — use their dedicated API or MCP tool if available
- API requests — use curl or an HTTP tool
- Code, files, or anything that doesn't need a browser

Return statuses:
- "complete" — task succeeded, result in "answer"
- "error" — task failed. Call browser_screenshot to see the page, then browser_message to retry or browser_stop to clean up.
- "waiting" — the agent is paused and asking a question (see "question" field). Call browser_message with the answer to resume.
- "timeout" — the 5-minute window elapsed but the task is still running in the browser. This is normal for long tasks. Call browser_screenshot to check progress, then browser_message to continue or browser_stop to end.`,
        inputSchema: {
            type: "object",
            properties: {
                task: {
                    type: "string",
                    description: "What you want done in the browser. Be specific: include the website, the goal, and any details that matter (e.g. 'on linkedin.com, post an article about X' not just 'post something').",
                },
                url: {
                    type: "string",
                    description: "Starting URL to navigate to before the task begins. If omitted, the agent figures out where to go from the task description.",
                },
                context: {
                    type: "string",
                    description: "All the information the agent might need: form field values, text to paste, tone/style preferences, credentials, choices to make. Dump everything relevant here — the more you provide, the fewer round-trips. Without this, the agent will pause and ask.",
                },
            },
            required: ["task"],
        },
    },
    {
        name: "browser_message",
        description: `Send a follow-up message to a running or finished browser session. Blocks until the agent acts on it.

Use cases:
- Answer a question: when browser_start returned "waiting", the agent needs info. Pass the answer here.
- Correct or refine: "actually change the quantity to 3", "use the second address instead"
- Continue after completion: "now click the Download button", "go to the next page and do the same thing"
- Retry after error: "try again", "click the other link instead"

The browser window is still open from the original browser_start call, so the agent picks up exactly where it left off. Returns the same statuses as browser_start (complete, error, or waiting).`,
        inputSchema: {
            type: "object",
            properties: {
                session_id: { type: "string", description: "Session ID from browser_start." },
                message: { type: "string", description: "Follow-up instructions or answer to the agent's question." },
            },
            required: ["session_id", "message"],
        },
    },
    {
        name: "browser_status",
        description: `Check the current status of browser sessions.

Returns session ID, status, task description, and the last 5 steps. Useful when a previous browser_start timed out and you want to see if the agent is still making progress, or to list all active sessions before deciding which to message or stop.`,
        inputSchema: {
            type: "object",
            properties: {
                session_id: { type: "string", description: "Check a specific session. If omitted, returns all running sessions." },
            },
        },
    },
    {
        name: "browser_stop",
        description: `Stop a browser session. The agent stops but the browser window stays open so the user can review the result.

Without "remove", the session can still be resumed later with browser_message. With "remove: true", the browser window closes and the session is permanently deleted.`,
        inputSchema: {
            type: "object",
            properties: {
                session_id: { type: "string", description: "Session to stop." },
                remove: { type: "boolean", description: "If true, also close the browser window and delete session history. Cannot be resumed." },
            },
            required: ["session_id"],
        },
    },
    {
        name: "browser_screenshot",
        description: `Capture a screenshot of the current browser page. Returns a PNG image.

Call this when browser_start returns "error" or times out — see what the agent was looking at before deciding whether to retry with browser_message or give up with browser_stop.`,
        inputSchema: {
            type: "object",
            properties: {
                session_id: { type: "string", description: "Session to screenshot. If omitted, captures the currently active tab." },
            },
        },
    },
];
// --- MCP Server ---
const server = new Server({ name: "browser-automation", version: "1.0.0" }, { capabilities: { tools: { listChanged: false } } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case "browser_start": {
                const task = args?.task;
                const url = args?.url;
                const context = args?.context;
                if (!task?.trim()) {
                    return { content: [{ type: "text", text: "Error: task cannot be empty" }], isError: true };
                }
                // Pre-flight: check if extension is connected before committing to a 5-min wait
                if (!await isExtensionConnected()) {
                    openInBrowser(EXTENSION_URL);
                    return {
                        content: [{
                                type: "text",
                                text: `Chrome extension is not connected. Opening install page in your browser.\n\nIf already installed, make sure Chrome is open and the extension is enabled. Then try again.`,
                            }],
                        isError: true,
                    };
                }
                // Check concurrency
                const activeCount = [...sessions.values()].filter((s) => s.status === "running").length;
                if (activeCount >= MAX_CONCURRENT) {
                    return {
                        content: [{
                                type: "text",
                                text: `Too many parallel tasks (${activeCount}/${MAX_CONCURRENT}). Wait for some to complete or stop them first.`,
                            }],
                        isError: true,
                    };
                }
                const session = {
                    id: randomUUID().slice(0, 8),
                    task,
                    url,
                    context,
                    status: "running",
                    steps: [],
                };
                sessions.set(session.id, session);
                // Dispatch to browser extension
                await send({ type: "mcp_start_task", sessionId: session.id, task, url, context, licenseKey: LICENSE_KEY });
                console.error(`[MCP] Started task ${session.id}: ${task.slice(0, 80)}`);
                // Block until complete
                await waitForSession(session);
                return {
                    content: [{ type: "text", text: JSON.stringify(formatResult(session), null, 2) }],
                    isError: session.status === "error",
                };
            }
            case "browser_message": {
                const sessionId = args?.session_id;
                const message = args?.message;
                const session = sessions.get(sessionId);
                if (!session) {
                    return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
                }
                if (!message?.trim()) {
                    return { content: [{ type: "text", text: "Error: message cannot be empty" }], isError: true };
                }
                // If the agent is waiting for input (escalation), send the response directly
                if (session.status === "waiting" && session.escalateRequestId) {
                    const requestId = session.escalateRequestId;
                    session.escalateRequestId = undefined;
                    session.question = undefined;
                    session.status = "running";
                    session.answer = undefined;
                    session.error = undefined;
                    await send({ type: "mcp_escalate_response", sessionId, requestId, response: message });
                    console.error(`[MCP] Escalation response sent to ${sessionId}: ${message.slice(0, 80)}`);
                }
                else {
                    // Normal follow-up message
                    session.status = "running";
                    session.answer = undefined;
                    session.error = undefined;
                    await send({ type: "mcp_send_message", sessionId, message });
                    console.error(`[MCP] Message sent to ${sessionId}: ${message.slice(0, 80)}`);
                }
                // Block until the agent finishes acting on it
                await waitForSession(session);
                const msgResult = formatResult(session);
                return {
                    content: [{ type: "text", text: JSON.stringify(msgResult, null, 2) }],
                    isError: msgResult.status !== "complete" && msgResult.status !== "waiting",
                };
            }
            case "browser_status": {
                const sessionId = args?.session_id;
                if (sessionId) {
                    const session = sessions.get(sessionId);
                    if (!session) {
                        return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
                    }
                    return { content: [{ type: "text", text: JSON.stringify(formatResult(session), null, 2) }] };
                }
                const active = [...sessions.values()]
                    .filter((s) => s.status === "running")
                    .map(formatResult);
                return { content: [{ type: "text", text: JSON.stringify(active, null, 2) }] };
            }
            case "browser_stop": {
                const sessionId = args?.session_id;
                const session = sessions.get(sessionId);
                if (!session) {
                    return { content: [{ type: "text", text: `Session not found: ${sessionId}` }], isError: true };
                }
                await send({ type: "mcp_stop_task", sessionId, remove: args?.remove === true });
                if (args?.remove) {
                    sessions.delete(sessionId);
                    return { content: [{ type: "text", text: `Session ${sessionId} removed.` }] };
                }
                session.status = "stopped";
                session.resolve?.();
                return { content: [{ type: "text", text: `Session ${sessionId} stopped.` }] };
            }
            case "browser_screenshot": {
                const sessionId = args?.session_id;
                const requestId = sessionId || `screenshot-${Date.now()}`;
                const screenshotPromise = new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        pendingScreenshots.delete(requestId);
                        resolve(null);
                    }, 5000);
                    pendingScreenshots.set(requestId, { resolve, timeout });
                });
                await send({ type: "mcp_screenshot", sessionId: requestId });
                const data = await screenshotPromise;
                if (data) {
                    return {
                        content: [
                            { type: "image", data, mimeType: "image/png" },
                            { type: "text", text: "Screenshot of current browser state" },
                        ],
                    };
                }
                return { content: [{ type: "text", text: "Screenshot timed out." }], isError: true };
            }
            default:
                return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
        }
    }
    catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
});
// --- Startup ---
async function main() {
    console.error("[MCP] Starting...");
    connection = new WebSocketClient({
        role: "mcp",
        autoStartRelay: true,
        onDisconnect: () => console.error("[MCP] Relay disconnected, will reconnect"),
    });
    connection.onMessage(handleMessage);
    await connection.connect();
    console.error("[MCP] Connected to relay");
    // Onboarding diagnostics — check if the Chrome extension is connected
    try {
        if (await isExtensionConnected()) {
            console.error("[MCP] Extension connected — ready for tasks");
        }
        else {
            console.error("[MCP] Extension not connected — opening install page...");
            openInBrowser(EXTENSION_URL);
        }
    }
    catch {
        // Non-fatal — don't block startup
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[MCP] Server running");
}
main().catch((error) => {
    console.error("[MCP] Fatal:", error);
    process.exit(1);
});
