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
  console.log(`[Mock] Returning ${reviews.length} mock reviews`);
  res.json({ reviews });
});

// ── Step 1: Fetch Reviews from Play Console ───────────────────

app.post("/api/fetch-reviews", async (req, res) => {
  if (!checkRate(req, res, "fetch")) return;
  try {
    const { browser_session_id, app_name, package_name } = req.body;
    if (!browser_session_id || !app_name) {
      return res.status(400).json({ error: "browser_session_id and app_name required" });
    }

    const appIdentifier = package_name
      ? `app with package name "${package_name}"`
      : `app named "${app_name}"`;

    console.log(`[Browser] Fetching reviews for ${app_name}...`);

    const result = await hanziClient.runTask(
      {
        browserSessionId: browser_session_id,
        task: `Go to Google Play Console (https://play.google.com/console/) and fetch recent unanswered user reviews for the ${appIdentifier}.

Steps:
1. Navigate to https://play.google.com/console/
2. Find the ${appIdentifier} in the app list and click on it
3. In the left sidebar, find "Ratings and reviews" or "User feedback" → click on it
4. Look for a way to filter to show only reviews WITHOUT a reply (unanswered reviews)
5. Read all visible unanswered reviews (up to 20)
6. For each review collect:
   - Reviewer name
   - Star rating (1-5)
   - Review text (full)
   - Date posted
   - Review ID or any unique identifier visible in the URL or page

Return a structured list of all reviews found. If no unanswered reviews exist, say so clearly.`,
      },
      { timeoutMs: 5 * 60 * 1000 }
    );

    console.log(`[Browser] Fetch result: ${result.status} (${result.steps} steps)`);

    if (result.status !== "complete") {
      return res.status(500).json({
        error: `Browser task ended with status: ${result.status}. Make sure you are logged into Google Play Console in Chrome.`,
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
    console.log(`[Strategy] Parsed ${reviews.length} reviews`);
    res.json({ reviews, raw_answer: result.answer });
  } catch (err) {
    console.error("[Browser] Fetch reviews error:", err.message);
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

    console.log(`[Strategy] Drafting responses for ${reviews.length} reviews...`);

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

    console.log(`[Strategy] Drafted ${drafts.length} responses`);
    res.json({ drafts });
  } catch (err) {
    console.error("[Strategy] Draft error:", err.message);
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

    console.log(`[Browser] Posting response to review by ${reviewer}...`);

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

    console.log(`[Browser] Post result: ${result.status}`);
    res.json({ result: result.status, steps: result.steps });
  } catch (err) {
    console.error("[Browser] Post response error:", err.message);
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
