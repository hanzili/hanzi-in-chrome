/**
 * MCP tool definitions and prompt templates.
 *
 * Pure data — no runtime dependencies. Loaded by the MCP server (index.ts).
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
// --- Tool definitions ---
export const TOOLS = [
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
// --- Prompt definitions ---
export const PROMPTS = [
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
// --- Skill file loader + prompt templates ---
const __skillDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
function loadSkillContent(skillName) {
    const skillPath = join(__skillDir, skillName, "SKILL.md");
    try {
        const raw = readFileSync(skillPath, "utf-8");
        return raw.replace(/^---[\s\S]*?---\n*/, ""); // Strip YAML frontmatter
    }
    catch {
        return `Error: Could not read ${skillName}/SKILL.md. Make sure the file exists at server/skills/${skillName}/SKILL.md`;
    }
}
export const PROMPT_TEMPLATES = {
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

${loadSkillContent("linkedin-prospector")}`,
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

${loadSkillContent("e2e-tester")}`,
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

${loadSkillContent("social-poster")}`,
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

${loadSkillContent("x-marketer")}`,
                    },
                },
            ],
        };
    },
};
