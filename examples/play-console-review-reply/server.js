/**
 * Play Console Review Reply — Free Tool by Hanzi Browse
 *
 * Architecture:
 *   - Server is STATELESS — all review/draft state lives in the client (localStorage)
 *   - Two AI layers: Browser Agent (Hanzi) fetches reviews from Play Console,
 *                    Strategy AI (Claude) categorizes and drafts responses
 *   - User approves each draft, Browser Agent posts approved responses
 *
 * Setup:
 *   HANZI_API_KEY=hic_live_...   (browser automation)
 *   ANTHROPIC_API_KEY=sk-...     (strategy AI — or set LLM_BASE_URL for proxy)
 *   npm start
 */

import express from "express";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { HanziClient } from "../../sdk/dist/index.js";

if (!process.env.no_proxy) process.env.no_proxy = "localhost,127.0.0.1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));

const HANZI_KEY = process.env.HANZI_API_KEY;
const HANZI_URL = process.env.HANZI_API_URL || "https://api.hanzilla.co";
const LLM_KEY = process.env.ANTHROPIC_API_KEY || "ccproxy";
const LLM_URL = process.env.LLM_BASE_URL || "https://api.anthropic.com";
const LLM_MODEL = process.env.LLM_MODEL || "claude-sonnet-4-6";
const PORT = process.env.PORT || 3002;

if (!HANZI_KEY) {
  console.error("Set HANZI_API_KEY");
  process.exit(1);
}

const hanziClient = new HanziClient({ apiKey: HANZI_KEY, baseUrl: HANZI_URL });

// Track active task IDs so we can cancel them
const activeTasks = new Map(); // browser_session_id → taskId

// ── Session log (in-memory, cleared on restart) ───────────────
const sessionLog = [];
function log(level, message, data = {}) {
  const entry = { ts: new Date().toISOString(), level, message, ...data };
  sessionLog.push(entry);
  if (sessionLog.length > 500) sessionLog.shift(); // keep last 500 entries
  const prefix = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : '[INFO]';
  console.log(`${prefix} ${message}`, Object.keys(data).length ? JSON.stringify(data) : '');
}

app.get("/api/logs", (_req, res) => {
  res.json({ logs: sessionLog });
});
const HTML = readFileSync(join(__dirname, "index.html"), "utf-8");

// ── Rate Limiting ─────────────────────────────────────────────

const rateLimits = new Map();
const LIMITS = { fetch: 5, draft: 10, post: 20 };

function checkRate(req, res, action) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now - entry.reset > 86400000) {
    entry = { fetch: 0, draft: 0, post: 0, reset: now };
    rateLimits.set(ip, entry);
  }
  if (entry[action] >= LIMITS[action]) {
    res.status(429).json({
      error: `Daily limit reached (${LIMITS[action]} ${action} requests/day). Come back tomorrow or get your own API key at hanzilla.co.`,
    });
    return false;
  }
  entry[action]++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateLimits) {
    if (now - e.reset > 86400000) rateLimits.delete(ip);
  }
}, 3600000);

// ── Strategy AI ───────────────────────────────────────────────

async function llm(system, user) {
  const res = await fetch(`${LLM_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": LLM_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));
  return data.content?.[0]?.text || "";
}

function extractJSON(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  if (fenced) try { return JSON.parse(fenced[1]); } catch {}
  const raw = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (raw) try { return JSON.parse(raw[0]); } catch {}
  return null;
}

// ── Static & Proxy Routes ─────────────────────────────────────

app.get("/embed.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  const localPath = join(__dirname, "embed.js");
  const repoPath = join(__dirname, "../../landing/embed.js");
  res.end(readFileSync(existsSync(localPath) ? localPath : repoPath, "utf-8"));
});

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(HTML);
});

app.get("/v1/browser-sessions", async (req, res) => {
  try {
    const sessions = await hanziClient.listSessions();
    res.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        status: s.status,
        connected_at: s.connectedAt,
        last_heartbeat: s.lastHeartbeat,
        label: s.label || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/v1/browser-sessions/pair", async (req, res) => {
  try {
    const data = await hanziClient.createPairingToken();
    res.json({
      pairing_token: data.pairingToken,
      pairing_url: `${HANZI_URL}/pair/${data.pairingToken}`,
      expires_at: data.expiresAt,
      expires_in_seconds: data.expiresInSeconds,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Mock Reviews (for UI testing without a real app) ─────────

app.post("/api/mock-reviews", (req, res) => {
  const reviews = [
    { id: "mock-1", reviewer: "Alice K.", rating: 2, date: "April 8, 2026",
      text: "App crashes every time I try to open the settings page. Pixel 7, Android 14. Please fix ASAP." },
    { id: "mock-2", reviewer: "Bob M.", rating: 5, date: "April 7, 2026",
      text: "Best app I've used in years. Clean UI and everything just works. Keep it up!" },
    { id: "mock-3", reviewer: "Chen W.", rating: 3, date: "April 6, 2026",
      text: "Good app overall but I really wish there was a dark mode. Also can you add export to CSV?" },
    { id: "mock-4", reviewer: "Diana L.", rating: 1, date: "April 5, 2026",
      text: "Paid for premium and it doesn't work. The sync feature is completely broken. Want a refund." },
    { id: "mock-5", reviewer: "Ethan P.", rating: 4, date: "April 4, 2026",
      text: "How do I transfer my data to a new phone? Can't find this in the settings anywhere." },
  ];
  log('info', `Mock reviews returned`, { count: reviews.length });
  res.json({ reviews });
});

// ── Cancel fetch ─────────────────────────────────────────────

app.post("/api/cancel-fetch", async (req, res) => {
  const { browser_session_id } = req.body;
  const taskId = activeTasks.get(browser_session_id);
  if (taskId) {
    try { await hanziClient.cancelTask(taskId); } catch {}
    activeTasks.delete(browser_session_id);
    log('info', 'Task cancelled', { task_id: taskId });
  }
  res.json({ cancelled: !!taskId });
});

// ── Step 1: Fetch Reviews from Play Console ───────────────────

app.post("/api/fetch-reviews", async (req, res) => {
  if (!checkRate(req, res, "fetch")) return;
  try {
    const { browser_session_id, app_name, package_name, account_email } = req.body;
    if (!browser_session_id || !app_name) {
      return res.status(400).json({ error: "browser_session_id and app_name required" });
    }

    const appIdentifier = package_name
      ? `app with package name "${package_name}"`
      : `app named "${app_name}"`;

    log('info', 'Fetching reviews', { app_name, account_email: account_email || null });

    const accountSection = account_email
      ? `IMPORTANT — Account selection rules (follow exactly, no exceptions):
- The user has chosen the account: ${account_email}
- Navigate to https://play.google.com/console/

Step A — Select the correct account:
  - If an account chooser appears: click ONLY "${account_email}". Do not click any other account.
  - If "${account_email}" is not in the chooser list: STOP. Return: ACCOUNT_NOT_FOUND: "${account_email}"
  - If you land on a Play Console dashboard but the active account is NOT "${account_email}":
      1. Click the profile picture / account avatar in the top-right corner
      2. A dropdown appears — look for "${account_email}" in the list
      3. If found: click "${account_email}" to switch. Wait for the page to reload, then continue.
      4. If NOT found in the dropdown: STOP. Return: ACCOUNT_NOT_FOUND: "${account_email}"
  - NEVER sign in with a password. NEVER create an account. NEVER try more than one account switch.

Step B — Verify:
  - Confirm the dashboard now shows "${account_email}" as the active account before proceeding.
  - If ANY unexpected screen appears (setup wizard, payment, identity verification, etc.): STOP. Describe exactly what you see.

Only after confirming you are in the correct account, proceed to fetch reviews.`
      : `IMPORTANT — Account selection rules (follow exactly, no exceptions):
- Navigate to https://play.google.com/console/
- If Google shows an account chooser with 2 or more accounts: STOP immediately.
  Return exactly: MULTIPLE_ACCOUNTS: ["email1@gmail.com", "email2@gmail.com", ...]
  List ALL accounts visible. Do NOT click any account.
- If there is only ONE account shown, or you are already logged in: continue normally.
- NEVER create an account, NEVER sign in, NEVER try to fix account issues.`;

    const task = await hanziClient.createTask({
      browserSessionId: browser_session_id,
      task: `Go to Google Play Console (https://play.google.com/console/) and fetch recent unanswered user reviews for the ${appIdentifier}.

${accountSection}

Fetching steps (only after correct account is active):
1. Find the ${appIdentifier} in the app list and click on it
2. In the left sidebar, find "Ratings and reviews" or "User feedback" → click on it
3. Filter to show only reviews WITHOUT a reply (unanswered reviews)
4. Read all visible unanswered reviews (up to 20)
5. For each review collect:
   - Reviewer name
   - Star rating (1-5)
   - Review text (full)
   - Date posted

Return a structured list of all reviews found. If no unanswered reviews exist, say so clearly.`,
    });

    activeTasks.set(browser_session_id, task.id);
    log('info', 'Task started', { task_id: task.id, app_name, account_email: account_email || null });

    // Poll manually — track last known answer so cancel has something to show
    const deadline = Date.now() + 5 * 60 * 1000;
    let result = task;
    let lastAnswer = "";
    while (Date.now() < deadline && result.status === "running") {
      await new Promise(r => setTimeout(r, 3000));
      result = await hanziClient.getTask(task.id);
      if (result.answer) lastAnswer = result.answer;
      log('info', `Task poll: ${result.status}`, { task_id: task.id, steps: result.steps });
    }
    activeTasks.delete(browser_session_id);
    if (result.status === "running") result = { ...result, status: "timeout" };
    if (!result.answer && lastAnswer) result = { ...result, answer: lastAnswer };

    log('info', 'Task finished', { task_id: task.id, status: result.status, steps: result.steps });

    // Detect multiple accounts signal from agent
    if (result.answer?.includes("MULTIPLE_ACCOUNTS:")) {
      const match = result.answer.match(/MULTIPLE_ACCOUNTS:\s*(\[.*?\])/s);
      let accounts = [];
      try { accounts = match ? JSON.parse(match[1]) : []; } catch {}
      log('info', 'Multiple accounts detected', { accounts });
      return res.status(409).json({ multiple_accounts: true, accounts });
    }

    // Detect agent signals
    if (result.answer?.includes("ACCOUNT_NOT_FOUND:") || result.answer?.includes("WRONG_ACCOUNT:")) {
      const detail = result.answer.match(/(ACCOUNT_NOT_FOUND|WRONG_ACCOUNT):\s*(.+)/)?.[2]?.trim();
      log('warn', 'Account signal from agent', { signal: result.answer });
      return res.status(422).json({
        account_error: true,
        account: account_email || null,
        last_action: result.answer,
        detail,
      });
    }

    // Detect account has Play Console but no apps published yet
    const noAppsSignals = [
      "no apps", "you don't have any apps", "create your first app",
      "no app named", "app not found", "could not find", "couldn't find"
    ];
    if (result.answer && noAppsSignals.some(s => result.answer.toLowerCase().includes(s))) {
      log('warn', 'Account has no apps', { answer: result.answer });
      return res.status(422).json({
        no_apps: true,
        account: account_email || null,
        last_action: result.answer,
      });
    }

    // Detect account has no Play Console at all
    const noConsoleSignals = [
      "finish setting up", "complete your account", "verify your identity",
      "not a developer", "create a developer account"
    ];
    if (result.answer && noConsoleSignals.some(s => result.answer.toLowerCase().includes(s))) {
      log('warn', 'Account has no Play Console', { answer: result.answer });
      return res.status(422).json({
        no_play_console: true,
        account: account_email || null,
        last_action: result.answer,
      });
    }

    if (result.status === "cancelled") {
      return res.status(499).json({
        cancelled: true,
        steps: result.steps,
        last_action: result.answer || "Agent was stopped before it could report back.",
      });
    }

    if (result.status !== "complete") {
      return res.status(500).json({
        error: `Browser task ended with status: ${result.status}. Make sure you are logged into Google Play Console in Chrome.`,
        steps: result.steps,
        last_action: result.answer || null,
      });
    }

    // Parse reviews out of the agent's answer with Strategy AI
    const parsed = await llm(
      "You extract structured review data from text. Return valid JSON only.",
      `Extract all reviews from this Play Console summary into JSON.

For each review include:
- id: a unique string (use reviewer name + date if no ID visible, e.g. "john_doe_2026-04-01")
- reviewer: reviewer display name
- rating: number 1-5
- text: full review text
- date: date string as shown

Browser summary:
${result.answer}

\`\`\`json
{"reviews": [{"id": "...", "reviewer": "...", "rating": 5, "text": "...", "date": "..."}]}
\`\`\``
    );

    const data = extractJSON(parsed);
    const reviews = data?.reviews || [];
    log('info', 'Reviews parsed', { count: reviews.length });
    res.json({ reviews, raw_answer: result.answer });
  } catch (err) {
    log('error', 'Fetch reviews error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Step 2: Draft Responses with Strategy AI ─────────────────

app.post("/api/draft-responses", async (req, res) => {
  if (!checkRate(req, res, "draft")) return;
  try {
    const { reviews, app_context } = req.body;
    if (!reviews?.length) return res.status(400).json({ error: "reviews required" });
    if (!app_context) return res.status(400).json({ error: "app_context required" });

    log('info', 'Drafting responses', { count: reviews.length });

    const result = await llm(
      `You are an experienced mobile app developer responding to Google Play Store reviews.
You write responses that are genuine, helpful, and human — not corporate or robotic.

RULES:
- Address the reviewer's specific concern directly
- For bug reports: acknowledge the issue, mention it's being looked into, ask for more details if needed
- For feature requests: thank them, say it's been noted
- For praise: thank them warmly, keep it short (1-2 sentences)
- For complaints: empathize first, then offer a path forward (email support, next update)
- Never be defensive
- Keep responses under 150 words
- Sound like a real developer, not a support bot`,

      `App: ${app_context.name}
Description: ${app_context.description || "N/A"}
Tone: ${app_context.tone || "friendly and professional"}
Support email: ${app_context.support_email || "N/A"}

Categorize each review and draft a response.

Categories:
- "bug_report": mentions a crash, error, or something not working
- "feature_request": asks for new functionality
- "praise": positive feedback, high rating
- "complaint": general dissatisfaction, low rating
- "question": asking how to do something

Reviews:
${JSON.stringify(reviews, null, 2)}

Return JSON:
\`\`\`json
{"drafts": [
  {
    "review_id": "...",
    "reviewer": "...",
    "rating": 4,
    "review_text": "...",
    "category": "bug_report",
    "response_text": "your drafted response",
    "reasoning": "one sentence explaining your approach"
  }
]}
\`\`\``
    );

    const parsed = extractJSON(result);
    const drafts = (parsed?.drafts || []).map((d, i) => ({
      id: `draft-${Date.now()}-${i}`,
      status: "pending",
      ...d,
    }));

    log('info', 'Responses drafted', { count: drafts.length });
    res.json({ drafts });
  } catch (err) {
    log('error', 'Draft responses error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Step 2b: Review Insights ──────────────────────────────────

app.post("/api/review-insights", async (req, res) => {
  try {
    const { reviews } = req.body;
    if (!reviews?.length) return res.status(400).json({ error: "reviews required" });

    log('info', 'Generating review insights', { count: reviews.length });

    const result = await llm(
      `You are a product analyst summarizing app store reviews for a developer.
Be concise and actionable. Focus on what the developer needs to know and act on.`,
      `Analyze these ${reviews.length} Google Play Store reviews and produce a developer-facing summary.

Reviews:
${JSON.stringify(reviews, null, 2)}

Return JSON:
\`\`\`json
{
  "avg_rating": 3.4,
  "sentiment": "mixed",
  "urgent_bugs": [
    {"issue": "App crashes on settings page", "mentioned_by": 2, "severity": "high"}
  ],
  "top_feature_requests": [
    {"feature": "Dark mode", "mentioned_by": 1}
  ],
  "common_praise": ["Clean UI", "Easy to use"],
  "action_items": [
    "Fix crash on settings page (mentioned by 2 users)",
    "Consider adding dark mode (requested)"
  ]
}
\`\`\``
    );

    const data = extractJSON(result);
    if (!data) return res.status(500).json({ error: "Failed to parse insights" });
    log('info', 'Insights generated', { action_items: data.action_items?.length });
    res.json(data);
  } catch (err) {
    log('error', 'Review insights error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Step 3: Post One Response ─────────────────────────────────

app.post("/api/post-response", async (req, res) => {
  if (!checkRate(req, res, "post")) return;
  try {
    const { browser_session_id, reviewer, rating, review_text, response_text, app_name, package_name } = req.body;
    if (!browser_session_id || !response_text || !reviewer) {
      return res.status(400).json({ error: "browser_session_id, reviewer, and response_text required" });
    }

    const appIdentifier = package_name
      ? `app with package name "${package_name}"`
      : `app named "${app_name}"`;

    log('info', 'Posting response', { reviewer });

    const result = await hanziClient.runTask(
      {
        browserSessionId: browser_session_id,
        task: `Go to Google Play Console and reply to a specific user review.

App: ${appIdentifier}
Reviewer: ${reviewer}
Their rating: ${rating} stars
Their review: "${review_text}"
Your response to post: "${response_text}"

Steps:
1. Navigate to https://play.google.com/console/
2. Open the ${appIdentifier}
3. Go to Ratings and reviews / User feedback
4. Find the review by ${reviewer} that says: "${review_text.substring(0, 80)}..."
5. Click "Reply" on that review
6. Type or paste the response: "${response_text}"
7. Submit the reply
8. Confirm the reply was posted successfully

IMPORTANT: Only reply to the review that matches both the reviewer name AND the review text above. Do not reply to any other reviews.`,
      },
      { timeoutMs: 3 * 60 * 1000 }
    );

    log('info', 'Post result', { status: result.status, steps: result.steps });
    res.json({ result: result.status, steps: result.steps });
  } catch (err) {
    log('error', 'Post response error', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
  Play Console Review Reply — Free Tool by Hanzi Browse
  http://localhost:${PORT}

  Strategy AI: ${LLM_URL} (${LLM_MODEL})
  Browser:     ${HANZI_URL}
  Rate limits: ${JSON.stringify(LIMITS)}
  `);
});
