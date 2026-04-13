import express from "express";
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { HanziClient } from "../../sdk/dist/index.js";

if (!process.env.no_proxy) process.env.no_proxy = "localhost,127.0.0.1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "2mb" }));

const POSTHOG_KEY = process.env.POSTHOG_API_KEY || "phc_SNXFKD8YOBPvBNWWZnuCe7stDsJJNJ5WS8MujKhajIF";
const HANZI_KEY = process.env.HANZI_API_KEY;
const HANZI_URL = process.env.HANZI_API_URL || "https://api.hanzilla.co";
const LLM_KEY = process.env.ANTHROPIC_API_KEY || "ccproxy";
const LLM_URL = process.env.LLM_BASE_URL || "https://api.anthropic.com";
const LLM_MODEL = process.env.LLM_MODEL || "claude-sonnet-4-6";
const PORT = process.env.PORT || 3001;

if (!HANZI_KEY) {
  console.error("Set HANZI_API_KEY");
  process.exit(1);
}

const HTML = readFileSync(join(__dirname, "index.html"), "utf-8");
const hanziClient = new HanziClient({ apiKey: HANZI_KEY, baseUrl: HANZI_URL });

const rateLimits = new Map();
const LIMITS = { plan: 8, test: 12, report: 8 };

function track(event, properties = {}, ip) {
  if (!POSTHOG_KEY) return;
  fetch("https://us.i.posthog.com/capture/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: POSTHOG_KEY,
      event,
      distinct_id: ip || "server",
      properties: { tool: "qa-tester", ...properties },
    }),
  }).catch(() => {});
}

function checkRate(req, res, action) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now - entry.reset > 86400000) {
    entry = { plan: 0, test: 0, report: 0, reset: now };
    rateLimits.set(ip, entry);
  }
  if (entry[action] >= LIMITS[action]) {
    res.status(429).json({
      error: `Daily limit reached (${LIMITS[action]} ${action} requests/day).`,
    });
    return false;
  }
  entry[action]++;
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now - entry.reset > 86400000) rateLimits.delete(ip);
  }
}, 3600000);

function extractJSON(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const firstObj = text.match(/\{[\s\S]*\}/);
  if (firstObj) {
    try { return JSON.parse(firstObj[0]); } catch {}
  }
  return null;
}

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

async function fetchPageSnapshot(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Hanzi QA Tester Preview Bot" },
      redirect: "follow",
    });
    const html = await res.text();
    return html.replace(/\s+/g, " ").slice(0, 12000);
  } catch {
    return "";
  }
}

function normalizeUrl(value) {
  try {
    const url = new URL(value);
    return url.toString();
  } catch {
    throw new Error("Enter a valid URL including https://");
  }
}

function severityRank(level) {
  return { Critical: 0, High: 1, Medium: 2, Low: 3 }[level] ?? 4;
}

async function collectScreenshots(taskId, count) {
  try {
    const steps = await hanziClient.getTaskSteps(taskId);
    const screenshotSteps = steps.filter((s) => s.screenshot).slice(0, Math.max(0, count));
    const images = [];
    for (const step of screenshotSteps) {
      try {
        const base64 = await hanziClient.getScreenshot(taskId, step.step);
        images.push({
          step: step.step,
          image: `data:image/jpeg;base64,${base64}`,
        });
      } catch {}
    }
    return images;
  } catch {
    return [];
  }
}

function buildPlanFallback(url, scope, description) {
  const appHint = description ? `App described as: ${description}. ` : "";
  const cases = [
    { id: "navigation", label: "Page load and navigation", category: "Core", steps: "Load the page and check for errors, broken links, or blank states." },
    { id: "forms", label: "Form submission and validation", category: "Core", steps: "Find and submit the main form with valid input, then with invalid input." },
    { id: "cta", label: "Primary call-to-action flows", category: "Core", steps: "Find the main CTA button and complete the flow it initiates." },
  ];
  if (scope === "full") {
    cases.push(
      { id: "errors", label: "Error states and edge cases", category: "Resilience", steps: "Try submitting empty forms, navigating to invalid routes, and triggering error states." },
      { id: "responsive", label: "Responsive layout and overflow", category: "UI", steps: "Check the page at mobile width (375px) for layout breakage or overflow." },
    );
  }
  return {
    app_type: "web app",
    app_summary: appHint + "Testing common user flows.",
    url,
    scope,
    test_cases: cases,
  };
}

async function generatePlan(url, scope, description, htmlSnippet) {
  const response = await llm(
    `You are a QA strategist generating a practical test plan for a web application.
Your goal is to find real bugs that would frustrate users, not pedantic edge cases.
Severity must be rated relative to what this specific app does — a broken checkout on an e-commerce site is Critical; a misaligned label on a portfolio is Low.
Return strict JSON only.`,
    `Create a QA test plan for this web app.

URL: ${url}
Scope: ${scope}
Developer's description: ${description || "not provided"}

Page HTML snapshot (for context):
<html>${htmlSnippet || "unavailable"}</html>

First, infer the app type (e.g. SaaS dashboard, e-commerce store, portfolio, landing page, CRUD tool).
Then generate test cases for the most impactful user flows.

If scope is "quick", generate 3 test cases covering the core happy path.
If scope is "full", generate 5 test cases covering core flows plus error states and edge cases.

Focus on:
- Flows that handle user data or money (signup, checkout, form submit)
- Navigation and routing (broken links, 404s, back button)
- JS errors or blank states after interaction
- Form validation (empty submit, bad input, success state)
- Responsive layout on common screen widths

Return JSON:
\`\`\`json
{
  "app_type": "inferred app type",
  "app_summary": "1 sentence describing what this app does based on the HTML",
  "url": "${url}",
  "scope": "${scope}",
  "test_cases": [
    {
      "id": "signup",
      "label": "User signup flow",
      "category": "Authentication",
      "steps": "brief description of what to do"
    }
  ]
}
\`\`\`
`
  );
  return extractJSON(response);
}

function testPrompt(url, testCase, appSummary) {
  return `You are a QA tester running a real-browser test on a web application.

App: ${appSummary || url}
Test: ${testCase.label}
${testCase.steps ? `Steps hint: ${testCase.steps}` : ""}

Core rules:
- Actually perform the test — click, type, submit, navigate. Do not just describe what you see.
- Take a screenshot when you find a bug or reach a key state.
- Verify issues are real before reporting them. One confirmed bug is better than five guesses.
- Rate severity relative to what this app does, not in absolute terms:
  - Critical: app crash, data loss, completely broken core flow (blocks the user entirely)
  - High: core flow broken but workaround exists, or significant data is wrong
  - Medium: degraded UX, confusing state, non-obvious failure
  - Low: cosmetic issue, minor inconsistency, polish gap
- Prefer 0–3 real findings over a padded list.
- Return strict JSON only.

Return JSON:
\`\`\`json
{
  "test_summary": "1–2 sentence summary of what you did and what you found",
  "passed": true,
  "passes": ["specific thing that worked correctly"],
  "bugs": [
    {
      "title": "Short bug title",
      "severity": "Critical|High|Medium|Low",
      "category": "e.g. Forms, Navigation, Auth, UI, Performance",
      "steps_to_reproduce": "numbered steps to reproduce",
      "expected": "what should happen",
      "actual": "what actually happened",
      "evidence": "what you observed in the browser"
    }
  ]
}
\`\`\`
`;
}

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
        external_user_id: s.externalUserId || null,
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

app.get("/api/sessions", async (req, res) => {
  try {
    const sessions = await hanziClient.listSessions();
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/pair", async (req, res) => {
  try {
    const data = await hanziClient.createPairingToken();
    res.json({ pairing_url: `${HANZI_URL}/pair/${data.pairingToken}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 1: crawl the page and generate a test plan
app.post("/api/plan", async (req, res) => {
  if (!checkRate(req, res, "plan")) return;
  try {
    const url = normalizeUrl(req.body.url || "");
    const scope = req.body.scope === "full" ? "full" : "quick";
    const description = (req.body.description || "").slice(0, 500);

    // Crawl the page first to give the planner real context about app structure
    const htmlSnippet = await fetchPageSnapshot(url);
    const planned = await generatePlan(url, scope, description, htmlSnippet).catch(() => null);
    const fallback = buildPlanFallback(url, scope, description);

    const plan = {
      id: `qa-${Date.now()}`,
      url,
      scope,
      description,
      app_type: planned?.app_type || fallback.app_type,
      app_summary: planned?.app_summary || fallback.app_summary,
      test_cases: (planned?.test_cases?.length ? planned.test_cases : fallback.test_cases)
        .slice(0, scope === "full" ? 5 : 3),
    };

    track("qa_plan_created", { scope, test_count: plan.test_cases.length }, req.ip);
    res.json({ plan });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Step 2: run one test case in the browser
app.post("/api/test-case", async (req, res) => {
  if (!checkRate(req, res, "test")) return;
  try {
    const { browser_session_id, url, test_case, app_summary } = req.body;
    if (!browser_session_id || !test_case?.id) {
      return res.status(400).json({ error: "browser_session_id and test_case are required" });
    }

    const task = await hanziClient.runTask({
      browserSessionId: browser_session_id,
      task: testPrompt(url, test_case, app_summary),
      url,
    }, { timeoutMs: 8 * 60 * 1000, pollIntervalMs: 3000 });

    if (task.status !== "complete" || !task.answer) {
      return res.status(500).json({ error: `Test failed: ${task.status}` });
    }

    const parsed = extractJSON(task.answer);
    if (!parsed) {
      return res.status(500).json({ error: "Could not parse test output" });
    }

    const bugs = Array.isArray(parsed.bugs) ? parsed.bugs : [];
    const screenshots = await collectScreenshots(task.id, bugs.length);
    const enrichedBugs = bugs.map((bug, index) => ({
      ...bug,
      severity: ["Critical", "High", "Medium", "Low"].includes(bug?.severity) ? bug.severity : "Medium",
      screenshot: screenshots[index]?.image || null,
      screenshot_step: screenshots[index]?.step || null,
    }));

    const result = {
      test_case,
      test_summary: parsed.test_summary || "",
      passed: enrichedBugs.length === 0,
      passes: Array.isArray(parsed.passes) ? parsed.passes : [],
      bugs: enrichedBugs.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
      task_id: task.id,
    };

    track("qa_test_complete", {
      test_id: test_case.id,
      bugs: result.bugs.length,
      passed: result.passed,
    }, req.ip);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 3: compile all results into a final report
app.post("/api/report", async (req, res) => {
  if (!checkRate(req, res, "report")) return;
  try {
    const { plan, test_results = [] } = req.body;
    if (!plan?.url || !Array.isArray(test_results)) {
      return res.status(400).json({ error: "plan and test_results are required" });
    }

    const bugs = test_results.flatMap((r) =>
      (r.bugs || []).map((b) => ({
        ...b,
        test_id: r.test_case?.id,
        test_label: r.test_case?.label,
      }))
    );

    const passes = [...new Set(test_results.flatMap((r) => r.passes || []))];
    const severity_totals = { Critical: 0, High: 0, Medium: 0, Low: 0 };
    for (const bug of bugs) {
      severity_totals[bug.severity] = (severity_totals[bug.severity] || 0) + 1;
    }

    const summaryText = await llm(
      `You are a senior QA engineer summarizing a real-browser test run for a developer.
Be direct and actionable. Return strict JSON only.`,
      `Summarize this QA test run.

App: ${plan.app_summary || plan.url}
Scope: ${plan.scope}
Tests run: ${test_results.length}

Bugs found:
${JSON.stringify(bugs.map((b) => ({
  title: b.title,
  severity: b.severity,
  category: b.category,
  test: b.test_label,
  steps: b.steps_to_reproduce,
  expected: b.expected,
  actual: b.actual,
})), null, 2)}

Passing checks:
${JSON.stringify(passes, null, 2)}

Return JSON:
\`\`\`json
{
  "headline": "short verdict (e.g. '3 bugs found, 1 blocks core flow')",
  "summary": "2–3 sentence summary for the developer",
  "top_priorities": ["most important fix 1", "most important fix 2", "most important fix 3"]
}
\`\`\`
`
    ).catch(() => "");

    const summary = extractJSON(summaryText) || {
      headline: bugs.length ? `${bugs.length} bug${bugs.length > 1 ? "s" : ""} found` : "All tested flows passed",
      summary: bugs.length
        ? "The QA run found issues in real browser testing. Prioritize Critical and High severity bugs before shipping."
        : "The tested flows completed without errors. Coverage is limited to the selected scope.",
      top_priorities: bugs.slice(0, 3).map((b) => b.title),
    };

    const grouped_bugs = {
      Critical: bugs.filter((b) => b.severity === "Critical"),
      High: bugs.filter((b) => b.severity === "High"),
      Medium: bugs.filter((b) => b.severity === "Medium"),
      Low: bugs.filter((b) => b.severity === "Low"),
    };

    track("qa_report_built", {
      scope: plan.scope,
      bugs: bugs.length,
      critical: severity_totals.Critical,
    }, req.ip);

    res.json({
      plan,
      summary: {
        headline: summary.headline,
        summary: summary.summary,
        top_priorities: Array.isArray(summary.top_priorities) ? summary.top_priorities.slice(0, 3) : [],
        severity_totals,
        tests_run: test_results.length,
        tests_passed: test_results.filter((r) => r.passed).length,
      },
      grouped_bugs,
      passes,
      test_results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`
  QA Tester — Free Tool by Hanzi Browse
  http://localhost:${PORT}

  Strategy AI: ${LLM_URL} (${LLM_MODEL})
  Browser:     ${HANZI_URL}
  Rate limits: ${JSON.stringify(LIMITS)}
  `);
});
