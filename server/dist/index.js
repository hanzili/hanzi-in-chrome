#!/usr/bin/env node
// If invoked as `npx hanzi-in-chrome setup`, delegate to the CLI
if (process.argv[2] === 'setup') {
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');
    const { execFileSync } = await import('child_process');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const cliPath = join(__dirname, 'cli.js');
    try {
        execFileSync(process.execPath, [cliPath, ...process.argv.slice(2)], { stdio: 'inherit' });
    }
    catch { /* exit code propagated */ }
    process.exit(0);
}
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
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { describeCredentials, resolveCredentials } from "./llm/credentials.js";
import { callLLM } from "./llm/client.js";
import { checkAndIncrementUsage, getLicenseStatus } from "./license/manager.js";
// --- Managed proxy mode ---
// When HANZI_API_KEY is set, tasks are proxied to the managed API instead of
// running locally. This lets users without their own LLM key use Hanzi managed.
const MANAGED_API_KEY = process.env.HANZI_API_KEY;
const MANAGED_API_URL = process.env.HANZI_API_URL || "https://api.hanzilla.co";
const IS_MANAGED_MODE = !!MANAGED_API_KEY;
async function managedApiCall(method, path, body) {
    const res = await fetch(`${MANAGED_API_URL}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${MANAGED_API_KEY}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
}
async function runManagedTask(task, url, context) {
    // Find a connected browser session
    const sessionsRes = await managedApiCall("GET", "/v1/browser-sessions");
    const connected = sessionsRes?.sessions?.find((s) => s.status === "connected");
    if (!connected) {
        return { status: "error", answer: "No browser connected. Open Chrome with the Hanzi extension and pair it first.", steps: 0 };
    }
    // Create task
    const created = await managedApiCall("POST", "/v1/tasks", {
        task, url, context, browser_session_id: connected.id,
    });
    if (created.error)
        return { status: "error", answer: created.error, steps: 0 };
    // Poll until done (max 5 min)
    const taskId = created.id;
    const deadline = Date.now() + TASK_TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        const status = await managedApiCall("GET", `/v1/tasks/${taskId}`);
        if (status.status !== "running") {
            return {
                status: status.status,
                answer: status.answer || "No answer.",
                steps: status.steps || 0,
                error: status.error,
            };
        }
    }
    return { status: "timeout", answer: "Task still running. Check back later.", steps: 0 };
}
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
function checkExtensionOnce() {
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
async function isExtensionConnected() {
    // Chrome suspends MV3 service workers after ~30s of inactivity, dropping the
    // WebSocket. The relay pings the extension every 20s to prevent this, but if
    // the connection was already lost, wait for the keepalive alarm to reconnect.
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 3000;
    for (let i = 0; i < MAX_RETRIES; i++) {
        if (await checkExtensionOnce())
            return true;
        if (i === 0) {
            console.error("[MCP] Extension not connected, waiting for service worker to wake up...");
        }
        if (i < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
    }
    return false;
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
        description: "Find people on LinkedIn and send personalized connection requests. Uses your real signed-in browser — LinkedIn has no API for this. Supports networking, sales, partnerships, and hiring strategies. Each connection note is unique.",
        arguments: [
            { name: "goal", description: "What you're trying to achieve: networking, sales, partnerships, hiring, or market-research", required: true },
            { name: "topic", description: "Topic, industry, or product area (e.g., 'browser automation', 'AI DevTools')", required: true },
            { name: "count", description: "How many people to find (default: 15)", required: false },
            { name: "context", description: "Extra context: your product, company, what you offer, who your ideal target is", required: false },
        ],
    },
    {
        name: "e2e-tester",
        description: "Test a web app in your real browser — click through flows and report what's broken with screenshots and code references. Gathers context from the codebase first, then uses the browser only for UI interaction and visual verification. Works on localhost, staging, and preview URLs.",
        arguments: [
            { name: "url", description: "App URL to test (e.g., 'localhost:3000', 'staging.myapp.com')", required: true },
            { name: "what", description: "What to test: 'signup flow', 'checkout', 'everything', or 'what I just changed'", required: false },
            { name: "credentials", description: "Test login credentials if needed (e.g., 'test@test.com / password123')", required: false },
        ],
    },
    {
        name: "social-poster",
        description: "Post content across social platforms from your real signed-in browser. Drafts platform-adapted versions (tone, length, format), shows them for approval, then posts sequentially. Works with LinkedIn, Twitter/X, Reddit, Hacker News, and Product Hunt.",
        arguments: [
            { name: "content", description: "What to post about: a topic, announcement, 'our latest release', or the exact text", required: true },
            { name: "platforms", description: "Where to post: 'linkedin', 'twitter', 'reddit', 'hackernews', 'producthunt', or 'all' (default: linkedin + twitter)", required: false },
            { name: "context", description: "Extra context: link to include, images, tone preference, target audience", required: false },
        ],
    },
    {
        name: "x-marketer",
        description: "Find conversations on X/Twitter where people discuss problems your product solves, research each author, draft voice-matched replies, and post from your real signed-in account. Supports three modes: conversations (find pain points), influencers (warm up large accounts), brand (monitor mentions). Loads your voice profile for natural-sounding replies.",
        arguments: [
            { name: "product", description: "Product name, URL, and one-line description", required: true },
            { name: "keywords", description: "Search terms to find relevant conversations (comma-separated)", required: true },
            { name: "mode", description: "conversations (default), influencers, or brand", required: false },
            { name: "count", description: "How many engagements per session (default: 10, max: 15)", required: false },
            { name: "context", description: "Extra context: pain points, competitors to avoid, tone preference", required: false },
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

## Tool selection rule

- Prefer existing tools first: code search, git diff, logs, APIs, local files, and other MCP integrations.
- Use Hanzi only for browser-required steps: LinkedIn prospecting is a logged-in UI workflow with no useful public API for this job.
- If LinkedIn shows a rate limit warning, CAPTCHA, or risk signal, stop immediately and tell me.

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
    "e2e-tester": (args) => {
        const url = args.url || "localhost:3000";
        const what = args.what || "";
        const credentials = args.credentials || "";
        return {
            description: "Test a web app in a real browser and report findings",
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `Test my web app at ${url} in a real browser and report what's working and what's broken.
${what ? `\nFocus on: ${what}` : ""}
${credentials ? `\nTest credentials: ${credentials}` : ""}

## Tool selection rule

- Prefer existing tools first: code search, git diff, logs, APIs, local files, and other MCP integrations. Gather all context you can before opening the browser.
- Use Hanzi only for browser-required steps: real UI interaction, visual verification, form submission, and anything that needs a rendered page.
- If a browser step could mutate real data, ask me before proceeding unless the environment is clearly local, dev, test, or preview.

## Safety: Check the target before testing

Browser tests create real state (signups, form submissions, orders). Before executing:

**Safe URLs (proceed without extra confirmation):** localhost, 127.0.0.1, 0.0.0.0, URLs with dev./staging./preview./.local, Vercel/Netlify preview URLs.

**Production or unknown URLs:** Ask me first: "This looks like a production URL. Should I test with real interactions (may create data), or stay read-only (just navigate and observe)?" Default to read-only if I don't answer.

**Credentials from .env:** Tell me what you found ("Found admin@test.com in .env.local") and confirm before using on non-local targets.

## Phase 1: Gather context BEFORE opening the browser

You have access to the codebase. Use it. Before touching the browser:

1. **Check what changed recently**: Run \`git diff --name-only HEAD~3\` or \`git log --oneline -5\` to see recent changes. This tells you what's most likely to be broken.

2. **Understand the app structure**: Look at routes, pages, or components to know what flows exist. Check for:
   - Route definitions (e.g., Next.js \`app/\` directory, React Router config, Express routes)
   - Key pages: login, signup, dashboard, checkout, settings
   - API endpoints the frontend calls

3. **Find test credentials**: Check \`.env\`, \`.env.local\`, \`seed\` files, or test fixtures for test accounts. Note what type of account you found (admin, test user, etc.) — don't silently use production credentials.

4. **Check if the server is running**: Run \`curl -s -o /dev/null -w "%{http_code}" ${url}\`. If it's not running, tell me to start it and stop here.

5. **Decide what to test**: Based on recent changes + app structure, prioritize:
   - Changed files first — if I touched the checkout page, test checkout
   - Critical paths — signup, login, core feature
   - If I said "everything", hit every major route

Present your test plan briefly: "I'll test: 1) signup, 2) login, 3) the checkout flow you changed in the last commit." Ask if I want to adjust before proceeding.

## Phase 2: Execute tests in the browser

Use \`browser_start\` for each flow. Test them **one at a time, sequentially**.

For each flow:
- Open the URL and navigate to the relevant page
- Interact like a real user: fill forms with realistic test data, click buttons, wait for responses
- Look for: broken layouts, missing elements, error messages, loading spinners that never stop, 404s, console errors visible on page
- Take note of what works AND what doesn't

**Important**: Tell the browser agent to be specific about what it sees. Not "the page looks fine" but "the signup form has 3 fields (name, email, password), I filled them in, clicked Submit, and was redirected to /dashboard with a welcome message."

If a flow requires login, log in first using the credentials I provided or that you found (with my confirmation).

If something fails, try to get specific error information — what error message appeared? What was the URL? What was the last thing that worked?

**After each \`browser_start\` returns**, call \`browser_screenshot\` (a separate MCP tool) to capture the final state. The browser window stays open, so the screenshot shows the page at the end of the flow. Do this for both passing and failing flows — screenshots are evidence.

## Phase 3: Report findings

After testing, write a clear report:

### Format:
\`\`\`
Tested [N] flows on ${url}:

✓ [Flow name] — [what happened, one line]
  📸 Screenshot: [describe what the screenshot shows]

✗ [Flow name] — [what's broken, specifically]
  📸 Screenshot: [what the page looked like when it failed]

⚠ [Flow name] — [works but has issues]
  📸 Screenshot: [evidence of the issue]
\`\`\`

### Then, for each failure:

**Cross-reference with the code.** This is your superpower — you can see both the browser AND the codebase. For each broken thing:
1. What did the browser show? (include the screenshot)
2. What file likely causes this? (check recent git changes, route handlers, API endpoints)
3. What's your best guess at the root cause?
4. Suggest a fix if it's obvious.

Example:
\`\`\`
✗ Checkout — form submits but the page hangs on a loading spinner.
  📸 Screenshot shows the payment form with a spinning loader, stuck for 30+ seconds.

  Likely cause: src/api/checkout.ts was modified in your last commit (abc123).
  You removed the \`onSuccess\` callback on line 45. The frontend is waiting
  for a response that never comes.

  Suggested fix: restore the onSuccess handler or add a redirect after
  the API call resolves.
\`\`\`

### Summary:
- Total flows tested / passed / failed / warnings
- If everything passes: "All tested flows working. Ready to push."
- If there are failures: prioritize them by severity

## Rules

- Don't test in parallel — one flow at a time via separate browser_start calls
- Don't guess — if you can't tell what's wrong, say so and suggest I check manually
- Don't skip the codebase analysis — it's what makes your report actionable instead of generic
- If the dev server isn't running, stop and tell me instead of reporting "page not found" as a bug
- If browser_start times out, call browser_screenshot to see where it got stuck
- Always take a screenshot after each flow — for both passes and failures
- On production URLs, default to read-only unless I explicitly opt in
- Don't silently use credentials from .env on non-local targets — confirm first`,
                    },
                },
            ],
        };
    },
    "social-poster": (args) => {
        const content = args.content || "";
        const platforms = args.platforms || "linkedin, twitter";
        const context = args.context || "";
        return {
            description: "Draft and post content across social platforms",
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `Post about this across social platforms: "${content}"

Platforms: ${platforms}
${context ? `\nExtra context: ${context}` : ""}

## Tool selection rule

- Prefer existing tools first: read the codebase, changelog, git log, README, or any source material to understand what to post about. Draft all content WITHOUT the browser.
- Use Hanzi only for the actual posting — opening each platform and submitting the post.
- Each post is a public action that cannot be undone. Show me every draft and get my approval before posting anything.

## Phase 1: Gather source material (no browser)

If I said something like "post about our latest release" or "post about the new feature":
1. Read the git log, changelog, README, or relevant files to understand what shipped
2. Identify the key points worth sharing
3. Find any links to include (docs, landing page, demo)

If I gave you the exact text, skip this and go to Phase 2.

## Phase 2: Draft per platform (no browser)

Write a separate version for each platform. Do NOT copy-paste the same text everywhere. Each platform has its own voice:

**LinkedIn:**
- Professional but not corporate. Storytelling works well.
- 1000-1500 chars ideal (can go up to 3000)
- Use line breaks for readability
- 3-5 hashtags at the end
- Include a link if relevant
- Bold key phrases using unicode (𝗯𝗼𝗹𝗱) sparingly

**Twitter/X:**
- Casual, punchy, opinionated
- Single tweet: under 280 chars
- If the content is too rich for one tweet, suggest a thread (number each tweet)
- 1-2 hashtags max, or none
- Link at the end

**Reddit:**
- Technical, no-BS, no marketing speak. Redditors hate self-promotion.
- Suggest the right subreddit (e.g., r/programming, r/webdev, r/machinelearning)
- Title should be informative, not clickbait
- Body in markdown
- If it's a project launch, frame it as "Show r/subreddit: ..."
- Be genuine about what it is and what it isn't

**Hacker News:**
- Ultra-minimal. Title + URL only.
- Title should be factual, not hypey ("Show HN: Tool that does X" format)
- No emoji, no exclamation marks
- Let the work speak for itself

**Product Hunt:**
- Launch-style: tagline + description + feature bullets
- Tagline: one punchy line under 60 chars
- Description: 2-3 sentences
- 3-5 key features as bullet points

### Show me all drafts in a clear format:

\`\`\`
--- LinkedIn ---
[draft text]

--- Twitter/X ---
[draft text]

--- Reddit (r/subreddit) ---
Title: [title]
Body: [draft text]
\`\`\`

Ask: "Ready to post these, or want to change anything?"

Do NOT proceed to posting until I confirm.

## Phase 3: Post (browser via Hanzi)

After I approve, post to each platform **one at a time, sequentially** using separate \`browser_start\` calls.

For each platform:
- Navigate to the platform (user is already logged in)
- Find the "new post" / "compose" area
- Paste the approved text
- Add any images or links if relevant
- Submit the post
- After \`browser_start\` returns, call \`browser_screenshot\` (a separate MCP tool) to capture the live post — the window stays open
- Note the URL of the published post if visible

If a platform requires additional steps (e.g., Reddit asks for a flair, Product Hunt needs a schedule), tell me and ask how to proceed.

If posting fails (CAPTCHA, rate limit, account restriction), skip that platform and report it.

## Phase 4: Report

\`\`\`
Posted to [N]/[total] platforms:

✓ LinkedIn — posted
  📸 Screenshot of live post
  URL: [url if available]

✓ Twitter/X — posted (2-tweet thread)
  📸 Screenshot of live post
  URL: [url if available]

✗ Reddit — r/programming requires account age > 30 days. Skipped.
\`\`\`

## Rules

- Never post without my explicit approval of the draft
- Never post to a platform I didn't ask for
- Don't use the same text across platforms — adapt each one
- If a platform blocks the post, don't retry — report and move on
- If browser_start times out, call browser_screenshot to see where it got stuck, then browser_message to continue
- Don't post images unless I provided them or explicitly asked for them
- One platform at a time, sequentially — not in parallel`,
                    },
                },
            ],
        };
    },
    "x-marketer": (args) => {
        const product = args.product || "";
        const keywords = args.keywords || "";
        const mode = args.mode || "conversations";
        const count = args.count || "10";
        const context = args.context || "";
        // Read the SKILL.md file for the full workflow
        const __dirname = dirname(fileURLToPath(import.meta.url));
        const skillPath = join(__dirname, "..", "skills", "x-marketer", "SKILL.md");
        let skillContent = "";
        try {
            const raw = readFileSync(skillPath, "utf-8");
            // Strip YAML frontmatter
            skillContent = raw.replace(/^---[\s\S]*?---\n*/, "");
        }
        catch {
            skillContent = "Error: Could not read x-marketer SKILL.md. Make sure the file exists at server/skills/x-marketer/SKILL.md";
        }
        return {
            description: "Find X/Twitter conversations and draft voice-matched replies",
            messages: [
                {
                    role: "user",
                    content: {
                        type: "text",
                        text: `Run the x-marketer skill.

Product: ${product}
Mode: ${mode}
Keywords: ${keywords}
Count: ${count}
${context ? `Extra context: ${context}` : ""}

${skillContent}`,
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
                // --- Managed proxy mode: forward to api.hanzilla.co ---
                if (IS_MANAGED_MODE) {
                    console.error(`[MCP] Managed mode — proxying task to ${MANAGED_API_URL}`);
                    const result = await runManagedTask(task, url, context);
                    return {
                        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                        isError: result.status === "error",
                    };
                }
                // --- Local BYOM mode ---
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
    if (IS_MANAGED_MODE) {
        console.error(`[MCP] Mode: MANAGED (proxying tasks to ${MANAGED_API_URL})`);
        console.error(`[MCP] API key: ${MANAGED_API_KEY.slice(0, 20)}...`);
    }
    else {
        console.error("[MCP] Mode: BYOM (local agent loop)");
        // Startup diagnostics
        const credDesc = describeCredentials();
        console.error(`[MCP] Credentials: ${credDesc}`);
        const licenseStatus = getLicenseStatus();
        console.error(`[MCP] License: ${licenseStatus.message}`);
    }
    connection = new WebSocketClient({
        role: "mcp",
        autoStartRelay: true,
        onDisconnect: () => console.error("[MCP] Relay disconnected, will reconnect"),
    });
    connection.onMessage(handleMessage);
    await connection.connect();
    console.error("[MCP] Connected to relay");
    // Quick extension check at startup (single probe, no retries — don't block startup)
    try {
        if (await checkExtensionOnce()) {
            console.error("[MCP] Extension connected — ready for tasks");
        }
        else {
            console.error("[MCP] Extension not connected — will retry when tasks arrive");
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
