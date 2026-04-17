/**
 * X Marketing — Free Tool by Hanzi Browse
 *
 * Public-facing free tool at browse.hanzilla.co/tools/x-marketing
 *
 * Architecture:
 *   - Server is STATELESS — all draft/product state lives in the client (localStorage)
 *   - Server provides: LLM calls, Hanzi Browse API proxy, rate limiting, email capture
 *   - Two AI layers: Strategy AI (Claude) analyzes/drafts, Browser AI (Hanzi Browse) searches/posts
 *
 * Setup:
 *   HANZI_API_KEY=hic_live_...  (browser automation — provided by us, many credits)
 *   ANTHROPIC_API_KEY=sk-...    (strategy AI — or set LLM_BASE_URL for proxy)
 *   npm start
 */

import express from "express";
import { readFileSync, existsSync, appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { HanziClient } from '../../sdk/dist/index.js';

// Keep proxy for external API calls (needed in China etc.)
// but bypass for localhost via no_proxy
if (!process.env.no_proxy) process.env.no_proxy = 'localhost,127.0.0.1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));

// ── Analytics (PostHog) & Error Tracking (Sentry) ────────────

const POSTHOG_KEY = process.env.POSTHOG_API_KEY || "";
const POSTHOG_HOST = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
const SENTRY_DSN = process.env.SENTRY_DSN || "";

function track(event, properties = {}, ip) {
  if (!POSTHOG_KEY) return;
  fetch(`${POSTHOG_HOST}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: POSTHOG_KEY,
      event,
      distinct_id: ip || "server",
      properties: { tool: "x-marketing", ...properties },
    }),
  }).catch(() => {});
}

const HANZI_KEY = process.env.HANZI_API_KEY;
const HANZI_URL = process.env.HANZI_API_URL || "https://api.hanzilla.co";
const LLM_KEY = process.env.ANTHROPIC_API_KEY || "ccproxy";
const LLM_URL = process.env.LLM_BASE_URL || "https://api.anthropic.com";
const LLM_MODEL = process.env.LLM_MODEL || "claude-sonnet-4-6";
const PORT = process.env.PORT || 3001;

if (!HANZI_KEY) { console.error("Set HANZI_API_KEY"); process.exit(1); }

const hanziClient = new HanziClient({
  apiKey: HANZI_KEY,
  baseUrl: HANZI_URL,
});

const POSTHOG_SNIPPET = POSTHOG_KEY
  ? `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);posthog.init(${JSON.stringify(POSTHOG_KEY)},{api_host:${JSON.stringify(POSTHOG_HOST)},person_profiles:'anonymous'})</script>`
  : "";
const HTML = readFileSync(join(__dirname, "index.html"), "utf-8").replace("__POSTHOG_SNIPPET__", POSTHOG_SNIPPET);

// ── Rate Limiting (per IP, resets daily) ─────────────────────

const rateLimits = new Map();
const LIMITS = { analyze: 10, search: 15, post: 15, email: 3, extract: 5 };

function checkRate(req, res, action) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now - entry.reset > 86400000) {
    entry = { analyze: 0, search: 0, post: 0, email: 0, extract: 0, reset: now };
    rateLimits.set(ip, entry);
  }
  if (entry[action] >= LIMITS[action]) {
    res.status(429).json({
      error: `Daily limit reached (${LIMITS[action]} ${action} requests/day). Come back tomorrow or get your own API key at browse.hanzilla.co.`,
    });
    return false;
  }
  entry[action]++;
  return true;
}

// Cleanup stale entries hourly
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateLimits) {
    if (now - e.reset > 86400000) rateLimits.delete(ip);
  }
}, 3600000);

// Pass upstream Hanzi Browse API errors through with the real status + a
// user-friendly message. Falls back to 500 for anything unrecognized.
function sendHanziError(res, err, label) {
  const status = err?.status ?? 500;
  const upstream = err?.data?.error || err?.message || "unknown error";
  console.log(`[${label}] ${status} — ${upstream}`);
  if (status === 402) {
    return res.status(402).json({
      error: "This demo has run out of tasks for the month. Ping @hanzili on X if you want to try the real product.",
      upstream,
    });
  }
  if (status === 429) {
    return res.status(429).json({ error: "Rate limited by Hanzi Browse — wait a moment and retry.", upstream });
  }
  if (status === 404) {
    return res.status(404).json({ error: "Browser session expired or disconnected — please reconnect.", upstream });
  }
  if (status === 401) {
    return res.status(500).json({ error: "Demo misconfigured (bad API key). Contact support.", upstream });
  }
  return res.status(status >= 400 && status < 600 ? status : 500).json({ error: upstream });
}

// ── Strategy AI (LLM calls) ──────────────────────────────────

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
  const raw = text.match(/\{[\s\S]*\}/);
  if (raw) try { return JSON.parse(raw[0]); } catch {}
  return null;
}

// ── Static & Proxy Routes ────────────────────────────────────

app.get("/embed.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  // Try local copy first (production), fall back to repo path (development)
  const localPath = join(__dirname, "embed.js");
  const repoPath = join(__dirname, "../../landing/embed.js");
  res.end(readFileSync(existsSync(localPath) ? localPath : repoPath, "utf-8"));
});

app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(HTML);
});

// Proxy for embed.js widget (avoids CORS)
app.get("/v1/browser-sessions", async (req, res) => {
  try {
    const sessions = await hanziClient.listSessions();
    res.json({ sessions: sessions.map(s => ({
      id: s.id,
      status: s.status,
      connected_at: s.connectedAt,
      last_heartbeat: s.lastHeartbeat,
      label: s.label || null,
      external_user_id: s.externalUserId || null,
    })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get("/api/sessions", async (req, res) => {
  try {
    const sessions = await hanziClient.listSessions();
    res.json({ sessions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/pair", async (req, res) => {
  try {
    const data = await hanziClient.createPairingToken();
    res.json({ pairing_url: `${HANZI_URL}/pair/${data.pairingToken}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Email Capture ────────────────────────────────────────────

const LEADS_FILE = join(__dirname, "leads.jsonl");

app.post("/api/capture-email", (req, res) => {
  if (!checkRate(req, res, "email")) return;
  const { email, product_name } = req.body;
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });

  const entry = { email, product_name, ip: req.ip, ts: new Date().toISOString() };
  try { appendFileSync(LEADS_FILE, JSON.stringify(entry) + "\n"); } catch {}
  console.log(`[Lead] ${email} — ${product_name || "unknown"}`);
  res.json({ ok: true });
});

// ── Cancel Search ────────────────────────────────────────────

const activeSearchTasks = new Map(); // browser_session_id → [taskIds]

app.post("/api/cancel-search", async (req, res) => {
  const { browser_session_id } = req.body;
  const taskIds = activeSearchTasks.get(browser_session_id) || [];
  const cancelled = [];
  for (const taskId of taskIds) {
    try { await hanziClient.cancelTask(taskId); cancelled.push(taskId); } catch {}
  }
  activeSearchTasks.delete(browser_session_id);
  console.log(`[Browser] Cancelled ${cancelled.length} tasks`);
  res.json({ cancelled });
});

// ── Search One Keyword (returns raw answer) ──────────────────

app.post("/api/search-one", async (req, res) => {
  if (!checkRate(req, res, "search")) return;
  try {
    const { browser_session_id, keyword } = req.body;
    if (!browser_session_id || !keyword) return res.status(400).json({ error: "browser_session_id and keyword required" });

    console.log(`[Browser] Searching keyword: "${keyword}"`);
    const task = await hanziClient.createTask({
      browserSessionId: browser_session_id,
      task: `Search X for: "${keyword}"

Navigate to https://x.com/search?q=${encodeURIComponent(keyword)}&src=typed_query&f=live

X BEHAVIOR — read carefully:
- X loads tweets asynchronously. After navigating, wait 5 seconds before reading.
- Use get_page_text (NOT read_page) to read tweets. read_page returns only "keyboard shortcuts" on X.
- If get_page_text returns nothing useful, wait 3 more seconds and try again. NEVER re-navigate to the same URL.
- Scroll down once to load more tweets, then get_page_text again.

Steps:
1. Navigate to the search URL
2. Wait 5 seconds
3. get_page_text
4. Scroll down: {"action": "scroll", "coordinate": [500, 400], "scroll_amount": 3, "scroll_direction": "down"}
5. Wait 2 seconds, get_page_text again
6. Write your summary

For each tweet, include:
- The FULL tweet URL (must contain /status/)
- Author @handle and display name
- Full tweet text
- Engagement counts (likes, replies, retweets)

List ALL tweets as a numbered list.`,
    });

    activeSearchTasks.set(browser_session_id, [...(activeSearchTasks.get(browser_session_id) || []), task.id]);
    console.log(`[Browser] Keyword "${keyword}" → task ${task.id}`);

    // Poll manually so we can track the task ID for cancellation
    const deadline = Date.now() + 10 * 60 * 1000;
    let result = task;
    while (Date.now() < deadline && result.status === "running") {
      await new Promise(r => setTimeout(r, 3000));
      result = await hanziClient.getTask(task.id);
    }
    if (result.status === "running") result = { ...result, status: "timeout" };

    console.log(`[Browser] Keyword "${keyword}" → ${result.status} (${result.steps} steps)`);
    track("search_keyword", { keyword, status: result.status, steps: result.steps }, req.ip);
    res.json({ keyword, answer: result.answer, status: result.status, steps: result.steps });
  } catch (err) {
    sendHanziError(res, err, `search-one:${req.body?.keyword || "?"}`);
  }
});

// ── Extract Tweets from Summaries ────────────────────────────

app.post("/api/extract", async (req, res) => {
  if (!checkRate(req, res, "extract")) return;
  try {
    const { summaries } = req.body;
    if (!summaries) return res.status(400).json({ error: "summaries required" });

    const urlCount = (summaries.match(/x\.com\/\w+\/status\/\d+/g) || []).length;
    console.log(`[Strategy] Extracting tweets from summaries (${summaries.length} chars, ${urlCount} URLs found in text)...`);

    const extraction = await llm(
      "You extract structured tweet data from text. Return valid JSON only.",
      `Extract each unique tweet from these X/Twitter search summaries into JSON. Deduplicate by URL.

For each tweet include: url, text, author_handle, author_name, engagement (likes/replies/retweets as numbers).
Only include tweets with a full URL containing /status/.

SUMMARIES:
${summaries}

\`\`\`json
{"tweets": [{"url": "https://x.com/user/status/123", "text": "...", "author_handle": "@user", "author_name": "Name", "engagement": {"likes": 0}}]}
\`\`\``
    );

    const parsed = extractJSON(extraction);
    const tweets = parsed?.tweets || [];

    if (tweets.length === 0 && urlCount > 0) {
      console.error(`[Strategy] EXTRACTION FAILED: ${urlCount} URLs in summaries but LLM returned 0 tweets`);
      console.error(`[Strategy] LLM response (first 500 chars): ${extraction.substring(0, 500)}`);
    }

    console.log(`[Strategy] Extracted ${tweets.length} unique tweets`);
    res.json({ tweets });
  } catch (err) {
    console.error("[Strategy] Extract error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Step 1: Analyze Product (stateless) ──────────────────────

app.post("/api/analyze", async (req, res) => {
  if (!checkRate(req, res, "analyze")) return;
  try {
    const { name, url, description, page_content } = req.body;
    console.log(`[Strategy] Analyzing product: ${name}${page_content ? " (with page content)" : ""}`);

    const contextBlock = page_content
      ? `\n\nHere is the actual content from their website:\n<page_content>\n${page_content}\n</page_content>`
      : "";

    const result = await llm(
      `You are an expert X/Twitter marketing strategist. Analyze a product and create a marketing strategy for finding and engaging with relevant conversations on X.`,
      `Analyze this product and create an X marketing strategy:

Product: ${name}
URL: ${url || "N/A"}
Description: ${description || "N/A"}${contextBlock}

Return a JSON object with:
- "keywords": array of 5-8 search keywords/phrases to find relevant tweets (mix of direct terms, pain points, and adjacent topics)
- "audience": one-sentence description of who we're targeting
- "voice": object with "tone" (casual/professional/technical), "style" (short description of how replies should sound), "never_use" (array of words/phrases to avoid)
- "product_pitch": one-sentence description to use when mentioning the product
- "pain_points": array of 3-5 specific problems the product solves

${page_content ? "Use the actual page content to deeply understand the product. Be specific — reference real features and benefits from the page." : ""}

Return ONLY the JSON, no other text.

\`\`\`json
{...}
\`\`\``
    );

    const strategy = extractJSON(result);
    if (!strategy) throw new Error("Failed to parse strategy");

    const product = { name, url, description, ...strategy };
    console.log(`[Strategy] Generated ${strategy.keywords?.length || 0} keywords`);
    track("tool_analyze", { product_name: name, keywords: strategy.keywords?.length }, req.ip);
    res.json(product);
  } catch (err) {
    console.error("[Strategy] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Step 1b: Read URL (uses browser) ─────────────────────────

app.post("/api/read-url", async (req, res) => {
  if (!checkRate(req, res, "analyze")) return;
  try {
    const { browser_session_id, url } = req.body;
    if (!browser_session_id || !url) return res.status(400).json({ error: "browser_session_id and url required" });

    console.log(`[Browser] Reading ${url}...`);
    const result = await hanziClient.runTask({
      browserSessionId: browser_session_id,
      task: `Open a new tab and go to ${url}

Read the page and extract:
- The main headline/tagline
- What the product does (features, benefits)
- Who it's for (target audience)
- Pricing if visible
- Any social proof (customer logos, testimonials, numbers)
- Key differentiators

Return a structured summary. Be thorough — read the full page, scroll down.`,
    }, { timeoutMs: 10 * 60 * 1000 });

    if (result.status !== "complete") {
      return res.status(500).json({ error: `Failed to read URL: ${result.status}` });
    }
    console.log(`[Browser] Page read complete`);
    res.json({ content: result.answer });
  } catch (err) {
    sendHanziError(res, err, "read-url");
    return;
  }
});

// ── Step 3: Draft Replies (stateless — client sends product) ─

app.post("/api/draft", async (req, res) => {
  if (!checkRate(req, res, "analyze")) return;
  try {
    const { tweets, product } = req.body;
    if (!tweets?.length) return res.status(400).json({ error: "tweets required" });
    if (!product) return res.status(400).json({ error: "product context required" });

    console.log(`[Strategy] Scoring ${tweets.length} tweets and drafting replies...`);

    const result = await llm(
      `You draft X/Twitter replies that sound like a real person typed them on their phone. You are NOT an AI assistant — you are a developer who happens to know about this product.

Voice:
- Tone: ${product.voice?.tone || "casual"}
- Style: ${product.voice?.style || "helpful, concise"}

HARD RULES — violating ANY of these means the reply is rejected:
- NEVER use em dashes (\u2014). Use "..." or "-" instead.
- NEVER use semicolons. Use periods or commas.
- NEVER start with "Hey!", "Great point!", "Love this!", "This is", "I'd recommend"
- NEVER use: leverage, harness, streamline, game-changer, unlock, elevate, seamless
- NEVER use perfect parallel structure (lists of 3 with matching grammar)
- NEVER write more than 2 sentences
- Under 200 characters is ideal, 280 max
- Use lowercase when it feels natural
- Use contractions always (don't, can't, it's, that's)
- Sentence fragments are good. Like this.
- Start with "honestly", "tbh", "yeah", "oh", "wait" sometimes
- Sound like a text to a friend who codes, not a LinkedIn post
- ${(product.voice?.never_use || []).join(", ")}
- Match the energy of the original poster`,

      `Product: ${product.name}
URL: ${product.url || ""}
Pitch: ${product.product_pitch || product.description}
Pain points: ${(product.pain_points || []).join("; ")}

Here are raw tweets collected from X. Score each 1-10, pick the top 5 REAL tweets, and draft a reply for each.

IMPORTANT: Skip bot accounts, spam posts, and low-quality tweets. Do NOT include them in the output at all — just silently drop them. Only return drafts for tweets worth replying to.

Scoring criteria:
- Relevance to our product's problem space
- Tweet posted recently (last 24h = high, older = low)
- Author quality (real person, relevant bio, 100+ followers)
- Reply visibility (few existing replies = your reply gets seen)
- Conversation potential (questions > statements)

Reply type mix — YOU MUST follow this distribution:
- Type A (2 out of 5): Pure value, no product mention. Build reputation.
- Type B (2 out of 5): Start with value, then NATURALLY mention "${product.name}" and its URL (${product.url || ""}). Example: "honestly the auth session part is what kills most setups. we built ${product.name} for exactly this — ${product.url || ""}"
- Type C (1 out of 5): Direct recommendation when they're asking for a tool. Example: "${product.name} does this — ${product.url || ""}"

AT LEAST 2 out of 5 replies MUST mention ${product.name} by name and include the URL. This is non-negotiable — the whole point is marketing.

Raw tweets:
${JSON.stringify(tweets, null, 2)}

Return JSON:
\`\`\`json
{"drafts": [
  {
    "tweet_url": "...",
    "tweet_text": "...",
    "author_handle": "@...",
    "author_name": "...",
    "author_bio": "...",
    "author_followers": 0,
    "reply_text": "your draft reply",
    "reply_type": "A|B|C",
    "score": 8,
    "reasoning": "why this tweet and this reply approach"
  }
]}
\`\`\``
    );

    const parsed = extractJSON(result);
    const drafts = (parsed?.drafts || []).map((d, i) => ({
      id: `d-${Date.now()}-${i}`,
      status: "pending",
      ...d,
    }));

    console.log(`[Strategy] Drafted ${drafts.length} replies`);
    track("drafts_created", { count: drafts.length, product_name: product.name }, req.ip);
    res.json({ drafts });
  } catch (err) {
    console.error("[Strategy] Draft error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Step 4: Post Reply (stateless — client sends everything) ─

app.post("/api/post", async (req, res) => {
  if (!checkRate(req, res, "post")) return;
  try {
    const { browser_session_id, tweet_url, reply_text } = req.body;
    if (!browser_session_id || !tweet_url || !reply_text) {
      return res.status(400).json({ error: "browser_session_id, tweet_url, and reply_text required" });
    }
    if (!tweet_url.includes("/status/")) {
      return res.status(400).json({ error: `Invalid tweet URL: ${tweet_url}` });
    }

    console.log(`[Browser] Posting reply to ${tweet_url}...`);

    const result = await hanziClient.runTask({
      browserSessionId: browser_session_id,
      task: `Open a new tab and navigate to this tweet: ${tweet_url}

YOUR ONLY JOB: Insert the reply text and click Reply. Nothing else. Do NOT navigate away.

Steps:
1. Wait 3 seconds for the page to load
2. Read the page
3. Click the reply/comment icon (speech bubble) on the tweet
4. A reply text area will appear — either inline or in a compose modal. BOTH ARE FINE.
5. Use javascript_tool to insert text:

document.querySelector('[data-testid="tweetTextarea_0"]').focus();
document.execCommand('insertText', false, ${JSON.stringify(reply_text)});

6. Read the page to confirm text appeared in the box
7. Click the blue "Reply" button (it appears next to the text area)
8. Done. Do NOT navigate anywhere after clicking Reply.

RULES:
- Use javascript_tool for text input — NEVER use computer type or form_input
- If you end up at x.com/compose/post — that is FINE, just type and click Reply there
- If you see "Leave site?" dialog — click CANCEL and stay on the page
- Do NOT press Escape, do NOT navigate back, do NOT close any modals
- Do NOT scroll down looking for anything — the reply area is where you opened it
- Maximum 12 tool calls for this task. If you haven't posted by step 12, stop.`,
    }, { timeoutMs: 2 * 60 * 1000 });
    console.log(`[Browser] Post result: ${result.status}`);
    track("reply_posted", { status: result.status, tweet_url }, req.ip);
    res.json({ result: result.status });
  } catch (err) {
    sendHanziError(res, err, "post");
    return;
  }
});

// ── Serve ────────────────────────────────────────────────────

// Node 18+ defaults server.requestTimeout to 5 minutes. Our browser tasks
// use runTask with a 10 minute timeout, so we bump Node's default to avoid
// killing long in-flight requests and surfacing "TypeError: Failed to fetch"
// to the client.
const server = app.listen(PORT, () => {
  console.log(`
  X Marketing — Free Tool by Hanzi Browse
  http://localhost:${PORT}

  Strategy AI: ${LLM_URL} (${LLM_MODEL})
  Browser:     ${HANZI_URL}
  Rate limits: ${JSON.stringify(LIMITS)}
  `);
});
server.requestTimeout = 15 * 60 * 1000;  // 15 min
server.headersTimeout = 16 * 60 * 1000;  // must be > requestTimeout
server.keepAliveTimeout = 65 * 1000;
