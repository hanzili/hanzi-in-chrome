#!/usr/bin/env node
/**
 * Hanzi in Chrome MCP Server
 *
 * MCP transport + session wrapper for the extension-side browser agent.
 * The Chrome extension owns browser execution; this server forwards tasks,
 * tracks session metadata, and waits for completion events.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketClient } from "./ipc/websocket-client.js";
import { randomUUID } from "crypto";
import { exec } from "child_process";
import { describeCredentials, resolveCredentials } from "./llm/credentials.js";
import { callLLM } from "./llm/client.js";
import { checkAndIncrementUsage, getLicenseStatus } from "./license/manager.js";
const sessions = new Map();
const pendingScreenshots = new Map();
// Max time a task can run before we return (configurable, default 5 minutes)
const TASK_TIMEOUT_MS = parseInt(process.env.HANZI_IN_CHROME_TIMEOUT_MS || String(5 * 60 * 1000), 10);
const MAX_CONCURRENT = parseInt(process.env.HANZI_IN_CHROME_MAX_SESSIONS || "5", 10);
const SESSION_TTL_MS = parseInt(process.env.HANZI_IN_CHROME_SESSION_TTL_MS || String(60 * 60 * 1000), 10);
// WebSocket relay connection
let connection;
const pendingWaiters = [];
/**
 * Wait for a specific message from the extension via WebSocket relay.
 * Returns null on timeout.
 */
function waitForRelayMessage(filter, timeoutMs = 60000) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            const idx = pendingWaiters.findIndex((w) => w.resolve === resolve);
            if (idx !== -1)
                pendingWaiters.splice(idx, 1);
            resolve(null);
        }, timeoutMs);
        pendingWaiters.push({ filter, resolve, timeout });
    });
}
/**
 * Route incoming relay messages to pending waiters.
 */
async function handleMessage(message) {
    if (message?.type === "mcp_get_info") {
        void handleGetInfoRequest(message);
        return;
    }
    if (message?.type === "mcp_escalate") {
        void handleEscalationRequest(message);
        return;
    }
    updateSessionFromMessage(message);
    // Check pending waiters first
    for (let i = 0; i < pendingWaiters.length; i++) {
        const waiter = pendingWaiters[i];
        if (waiter.filter(message)) {
            clearTimeout(waiter.timeout);
            pendingWaiters.splice(i, 1);
            waiter.resolve(message);
            return;
        }
    }
    // Handle screenshots for pending requests
    const { type, sessionId, ...data } = message;
    if (type === "screenshot" && data.data && sessionId) {
        const pending = pendingScreenshots.get(sessionId);
        if (pending) {
            clearTimeout(pending.timeout);
            pending.resolve(data.data);
            pendingScreenshots.delete(sessionId);
        }
    }
}
async function send(message) {
    await connection.send(message);
}
async function callTextModel(systemText, userText, maxTokens = 700) {
    const response = await callLLM({
        messages: [{ role: "user", content: userText }],
        system: [{ type: "text", text: systemText }],
        tools: [],
        maxTokens,
    });
    const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
    if (!text) {
        throw new Error("LLM returned no text content");
    }
    return text;
}
async function handleGetInfoRequest(message) {
    const { sessionId, query, requestId } = message;
    if (!requestId)
        return;
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    const context = session?.context?.trim();
    let responseText;
    if (!context) {
        responseText = `Information not found: no task context was provided for this session.`;
    }
    else {
        try {
            responseText = await callTextModel("Answer the user's query using only the provided task context. If the context does not contain the answer, reply exactly with 'Information not found.' Do not invent facts.", `Task context:\n${context}\n\nQuery:\n${query}`, 500);
        }
        catch (error) {
            responseText = `Information lookup failed: ${error.message}. Raw task context:\n${context}`;
        }
    }
    await send({
        type: "mcp_get_info_response",
        sessionId,
        requestId,
        response: responseText,
    });
}
async function handleEscalationRequest(message) {
    const { sessionId, requestId, problem, whatITried, whatINeed } = message;
    if (!requestId)
        return;
    const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    const taskSummary = session
        ? `Task: ${session.task}\nContext: ${session.context || "(none)"}\nRecent steps:\n${session.steps.slice(-8).join("\n") || "(none)"}`
        : "Task/session state unavailable.";
    let responseText;
    try {
        responseText = await callTextModel("You are a planning assistant helping a browser automation agent recover from a blocker. Give short, concrete next-step guidance. Prefer actions the browser agent can try immediately. If user input is required, say exactly what is missing.", `Session state:\n${taskSummary}\n\nProblem:\n${problem}\n\nWhat I tried:\n${whatITried || "(not provided)"}\n\nWhat I need:\n${whatINeed || "(not provided)"}`, 600);
    }
    catch (error) {
        responseText = `Escalation handling failed: ${error.message}. Try a smaller step, re-read the page, or request the missing information explicitly.`;
    }
    await send({
        type: "mcp_escalate_response",
        sessionId,
        requestId,
        response: responseText,
    });
}
function extractAnswer(result) {
    if (result == null)
        return undefined;
    if (typeof result === "string")
        return result;
    if (typeof result === "object") {
        const maybeMessage = result.message;
        if (typeof maybeMessage === "string")
            return maybeMessage;
        return JSON.stringify(result);
    }
    return String(result);
}
function updateSessionFromMessage(message) {
    const sessionId = message?.sessionId;
    if (!sessionId)
        return;
    const session = sessions.get(sessionId);
    if (!session)
        return;
    session.updatedAt = Date.now();
    switch (message.type) {
        case "task_update":
            session.status = message.status === "running" ? "running" : session.status;
            if (typeof message.step === "string" && message.step.trim()) {
                const lastStep = session.steps[session.steps.length - 1];
                if (lastStep !== message.step) {
                    session.steps.push(message.step);
                }
            }
            break;
        case "task_complete":
            session.status = "complete";
            session.answer = extractAnswer(message.result);
            session.error = undefined;
            break;
        case "task_error":
            session.status = "error";
            session.answer = undefined;
            session.error = typeof message.error === "string" ? message.error : "Task failed";
            break;
    }
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
    if (session.steps.length > 0) {
        result.total_steps = session.steps.length;
        result.recent_steps = session.steps.slice(-5);
    }
    return result;
}
function waitForSessionTerminal(sessionId, timeoutMs = TASK_TIMEOUT_MS) {
    return waitForRelayMessage((msg) => msg.sessionId === sessionId &&
        (msg.type === "task_complete" || msg.type === "task_error"), timeoutMs);
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
        const requestId = `status-${Date.now()}-${randomUUID().slice(0, 4)}`;
        const timeout = setTimeout(() => {
            connection.offMessage(handler);
            resolve(false);
        }, 2000);
        const handler = (msg) => {
            if (msg.type === "status_response" && msg.requestId === requestId) {
                clearTimeout(timeout);
                connection.offMessage(handler);
                resolve(msg.extensionConnected === true);
            }
        };
        connection.onMessage(handler);
        connection.send({ type: "status_query", requestId }).catch(() => resolve(false));
    });
}
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
        if (session.status === "running")
            continue;
        if (now - session.updatedAt > SESSION_TTL_MS) {
            sessions.delete(sessionId);
        }
    }
}, 5 * 60 * 1000);
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
- "timeout" — the 5-minute window elapsed but the task is still running in the browser. This is normal for long tasks. Call browser_screenshot to check progress, then browser_message to continue or browser_stop to end.`,
        inputSchema: {
            type: "object",
            properties: {
                task: {
                    type: "string",
                    description: "What you want done in the browser. Be specific: include the website, the goal, and any details that matter.",
                },
                url: {
                    type: "string",
                    description: "Starting URL to navigate to before the task begins.",
                },
                context: {
                    type: "string",
                    description: "All the information the agent might need: form field values, text to paste, tone/style preferences, credentials, choices to make.",
                },
            },
            required: ["task"],
        },
    },
    {
        name: "browser_message",
        description: `Send a follow-up message to a running or finished browser session. Blocks until the agent acts on it.

Use cases:
- Correct or refine: "actually change the quantity to 3", "use the second address instead"
- Continue after completion: "now click the Download button", "go to the next page and do the same thing"
- Retry after error: "try again", "click the other link instead"

The browser window is still open from the original browser_start call, so the agent picks up exactly where it left off.`,
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

Returns session ID, status, task description, and the last 5 steps.`,
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
                remove: { type: "boolean", description: "If true, also close the browser window and delete session history." },
            },
            required: ["session_id"],
        },
    },
    {
        name: "browser_screenshot",
        description: `Capture a screenshot of the current browser page. Returns a PNG image.

Call this when browser_start returns "error" or times out — see what the agent was looking at.`,
        inputSchema: {
            type: "object",
            properties: {
                session_id: { type: "string", description: "Session to screenshot. If omitted, captures the currently active tab." },
            },
        },
    },
];
// --- MCP Server ---
const server = new Server({ name: "browser-automation", version: "2.0.0" }, { capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
// --- Prompts ---
const PROMPTS = [
    {
        name: "linkedin-prospector",
        description: "Find people on LinkedIn and send personalized connection requests. Supports multiple strategies: search by posts (networking/community), by role/company (sales), by topic + seniority (partnerships), or by skills (hiring). Each connection note is unique and personalized.",
        arguments: [
            { name: "goal", description: "What you're trying to achieve: networking, sales, partnerships, hiring, or market-research", required: true },
            { name: "topic", description: "Topic, industry, or product area (e.g., 'browser automation', 'AI DevTools')", required: true },
            { name: "count", description: "How many people to find (default: 15)", required: false },
            { name: "context", description: "Extra context: your product, company, what you offer, who your ideal target is", required: false },
        ],
    },
];
const PROMPT_TEMPLATES = {
    "linkedin-prospector": (args) => {
        const count = args.count || "15";
        const goal = (args.goal || "networking").toLowerCase();
        const topic = args.topic || "";
        const context = args.context || "";
        return {
            description: "Find LinkedIn prospects and send personalized connections",
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `Find ${count} people on LinkedIn related to "${topic}" and send personalized connection requests.

My goal: **${goal}**
${context ? `\nContext about me/my product: ${context}` : ""}

## Step 1: Choose the right search strategy

Based on my goal, pick the best approach (or combine them):

**Networking / community building** → Search LinkedIn POSTS. Find people actively talking about the topic. These are engaged, vocal people — great for community.
URL: https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(topic)}

**Sales prospecting** → Search LinkedIn PEOPLE with role/industry filters. Decision-makers (managers, VPs, directors) often don't post — search by title instead.
URL: https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(topic)}
Add filters: use LinkedIn's built-in filters for seniority level, industry, company size, location.

**Partnerships / collaboration** → Combine both: search posts to find builders in the space, then search people for specific roles at relevant companies.

**Hiring** → Search people by skills and current role. Filter by location and experience level.

**Market research** → Search posts and read comments. Find what people are saying, who's engaging, what problems they mention.

Tell me which strategy you're going with before starting. If my goal suggests a clear strategy, just confirm it and proceed.

## Step 2: Collect prospects

For each person, gather personalization material. What you look for depends on how you found them:

- **Found via post search**: What they posted about, their take, any specific insight they shared
- **Found via people search**: Visit their profile. Look for: recent job change, About section, featured content, recent activity, mutual connections, company news
- **Found via both**: Combine signals — strongest personalization

Collect: name, headline, and at least one personalization hook per person.

## Step 3: Dedup with outreach log

Before searching, check prior outreach:
\`wc -l ~/.hanzi-in-chrome/contacted.txt 2>/dev/null || echo "0 (new log)"\`

Before sending to each person:
\`grep -qiF "Name Here" ~/.hanzi-in-chrome/contacted.txt 2>/dev/null\`
Skip if found (exit 0).

## Step 4: Show me the list before sending

Present a table:
| # | Name | Role / Company | Personalization hook | Why they match my goal | Status |

The "Personalization hook" column is key — it's the specific thing you'll reference in the note. If you don't have a strong hook for someone, flag it.

Ask me which ones to send to. I might want to adjust the list or the approach.

## Step 5: Send personalized connections

Send one at a time using separate browser_start calls — NOT in parallel.

Each connection note (max 300 chars) must:
1. **Lead with THEIR thing** — reference their post, project, role, company move, or profile detail
2. **Connect it to why you're reaching out** — make the relevance obvious
3. **Sound like a human** — conversational, not polished marketing copy

Personalization varies by how you found them:

**Post-based**: "Your post about [specific thing] resonated — I'm working on [related thing]. Would love to connect."
**Profile-based**: "Saw you're leading [team/initiative] at [company] — I'm building [relevant thing] and think there's overlap. Happy to share notes."
**Job-change-based**: "Congrats on the move to [company]! I work on [relevant thing] that might be useful as you're getting set up."
**Mutual-connection-based**: "We both know [person] — I noticed you're working on [thing] and thought we should connect."

After each send, log immediately:
\`mkdir -p ~/.hanzi-in-chrome && echo "Name Here" >> ~/.hanzi-in-chrome/contacted.txt\`

Report progress: "Sent 3/12 — continuing..."

## Safety rules

- Max 20 connection requests per session
- If LinkedIn shows a rate limit warning or CAPTCHA, stop immediately and tell me
- Every note must be unique — never copy-paste between people
- No links, no sales pitches, no product plugs in the connection note
- Don't send to people where you couldn't find a good personalization hook — skip and note why

## When done

Summarize:
- Strategy used and why
- Total found / sent / skipped (already contacted) / skipped (no good hook) / failed
- Running total from the log
- Any patterns noticed (common roles, topics, companies that kept appearing)`,
                    },
                },
            ],
        };
    },
};
server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const template = PROMPT_TEMPLATES[name];
    if (!template) {
        throw new Error(`Unknown prompt: ${name}`);
    }
    return template(args || {});
});
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
                // Check license / usage limit
                const usage = await checkAndIncrementUsage();
                if (!usage.allowed) {
                    return { content: [{ type: "text", text: usage.message }], isError: true };
                }
                console.error(`[MCP] ${usage.message}`);
                // Check credentials before starting
                const creds = resolveCredentials();
                if (!creds) {
                    return {
                        content: [{
                                type: "text",
                                text: "No LLM credentials found. Set ANTHROPIC_API_KEY env var or run `claude login`.",
                            }],
                        isError: true,
                    };
                }
                // Pre-flight: check if extension is connected
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
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
                sessions.set(session.id, session);
                console.error(`[MCP] Starting task ${session.id}: ${task.slice(0, 80)}`);
                const completionPromise = waitForSessionTerminal(session.id);
                await send({
                    type: "mcp_start_task",
                    sessionId: session.id,
                    task,
                    url,
                    context,
                });
                const result = await completionPromise;
                if (result === null) {
                    session.status = "timeout";
                    session.error = `Task still running after ${TASK_TIMEOUT_MS / 60000} minutes. Use browser_screenshot to check progress, then browser_message to continue or browser_stop to end.`;
                }
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
                session.status = "running";
                session.answer = undefined;
                session.error = undefined;
                session.updatedAt = Date.now();
                console.error(`[MCP] Message to ${sessionId}: ${message.slice(0, 80)}`);
                const completionPromise = waitForSessionTerminal(session.id);
                await send({
                    type: "mcp_send_message",
                    sessionId: session.id,
                    message,
                });
                const result = await completionPromise;
                if (result === null) {
                    session.status = "timeout";
                    session.error = `Task still running after ${TASK_TIMEOUT_MS / 60000} minutes.`;
                }
                const latestSession = sessions.get(session.id) || session;
                return {
                    content: [{ type: "text", text: JSON.stringify(formatResult(latestSession), null, 2) }],
                    isError: latestSession.status === "error",
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
                const all = [...sessions.values()].map(formatResult);
                return { content: [{ type: "text", text: JSON.stringify(all, null, 2) }] };
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
    console.error("[MCP] Starting Hanzi in Chrome MCP Server v2.0...");
    // Startup diagnostics
    const credDesc = describeCredentials();
    console.error(`[MCP] Credentials: ${credDesc}`);
    const licenseStatus = getLicenseStatus();
    console.error(`[MCP] License: ${licenseStatus.message}`);
    connection = new WebSocketClient({
        role: "mcp",
        autoStartRelay: true,
        onDisconnect: () => console.error("[MCP] Relay disconnected, will reconnect"),
    });
    connection.onMessage(handleMessage);
    await connection.connect();
    console.error("[MCP] Connected to relay");
    // Extension connectivity check
    try {
        if (await isExtensionConnected()) {
            console.error("[MCP] Extension connected — ready for tasks");
        }
        else {
            console.error("[MCP] Extension not connected — install from Chrome Web Store and enable it");
        }
    }
    catch {
        // Non-fatal — don't block startup
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[MCP] Server running (browser execution: extension-side)");
}
main().catch((error) => {
    console.error("[MCP] Fatal:", error);
    process.exit(1);
});
