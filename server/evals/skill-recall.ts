#!/usr/bin/env node
/**
 * Skill-recall eval: does an LLM pick the right tool when given the hanzi-browse
 * skill + a realistic toolbox for a user task?
 *
 * Usage: npx tsx server/evals/skill-recall.ts [--fail-fast] [--only <id>] [--model <name>]
 *
 * Uses the project's shared LLM client (Vertex Gemini in managed mode,
 * Anthropic otherwise). Cost: ~20 cases × ~600 tokens ≈ $0.01 on Haiku.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { parse as parseYaml } from "yaml";
import { callLLM } from "../src/llm/client.js";

interface TestCase {
  id: string;
  task: string;
  expected: string;
  allowed_alternatives?: string[];
  rationale: string;
}

interface Result {
  id: string;
  task: string;
  expected: string;
  picked: string;
  reason: string;
  pass: boolean;
  error?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSkill(): string {
  const path = join(__dirname, "..", "skills", "hanzi-browse", "SKILL.md");
  return readFileSync(path, "utf-8").replace(/^---[\s\S]*?---\s*/m, "").trim();
}

function loadCases(onlyId?: string): TestCase[] {
  const path = join(__dirname, "skill-recall.cases.yaml");
  const all = parseYaml(readFileSync(path, "utf-8")) as TestCase[];
  return onlyId ? all.filter(c => c.id === onlyId) : all;
}

function buildSystemPrompt(skillMd: string): string {
  return `You are choosing the right tool for a user task. Pick exactly one.

Available tools:
1. browser_start — delegates to a sub-agent running in the USER'S OWN Chrome (their real browser with their logged-in sessions). See the detailed skill description at the end of this prompt.
2. WebFetch — fetches raw HTML from a public URL. No login, no interaction, no JS execution.
3. web_search — searches the public web (like Google/Tavily) and returns summarized results.
4. Read — reads a local file on the user's disk.
5. Bash — runs a shell command.
6. none — the task needs no tool (conversational answer from context).

Respond with EXACTLY this JSON and nothing else:
{"tool": "<tool name>", "reason": "<one short sentence>"}

Do not add markdown fences, explanations, or prose outside the JSON.

---
Skill description for browser_start (hanzi-browse):

${skillMd}`;
}

/** Canonical tool names. LLM responses are normalized to these. */
const CANONICAL_TOOLS = ["browser_start", "WebFetch", "web_search", "Read", "Bash", "none"] as const;
type CanonicalTool = typeof CANONICAL_TOOLS[number];

/** Normalize any LLM-supplied tool name to our canonical form. Case- and underscore-insensitive. */
function normalizeTool(raw: string): string {
  const lower = raw.trim().toLowerCase().replace(/[\s_-]+/g, "_");
  // Map common variants back to canonical casing
  const byKey: Record<string, CanonicalTool> = {
    browser_start: "browser_start",
    hanzi: "browser_start",
    hanzi_browse: "browser_start",
    webfetch: "WebFetch",
    web_fetch: "WebFetch",
    fetch: "WebFetch",
    web_search: "web_search",
    websearch: "web_search",
    search: "web_search",
    tavily: "web_search",
    exa: "web_search",
    read: "Read",
    bash: "Bash",
    shell: "Bash",
    none: "none",
    no_tool: "none",
  };
  return byKey[lower] ?? raw.trim();
}

async function runCase(skillMd: string, c: TestCase, model?: string): Promise<Result> {
  const systemText = buildSystemPrompt(skillMd);
  try {
    const resp = await callLLM({
      system: [{ type: "text", text: systemText }],
      messages: [{ role: "user", content: [{ type: "text", text: c.task }] }],
      tools: [],
      model,
      maxTokens: 200,
    });
    const text = (resp.content.find(b => b.type === "text") as any)?.text ?? "";
    // Robust JSON extraction — tolerate surrounding text or code fences.
    // Use a balanced-brace scan so nested objects in "reason" don't truncate.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    const raw = start >= 0 && end > start ? text.slice(start, end + 1) : null;

    let picked = "unknown";
    let reason = "";
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        picked = normalizeTool(String(parsed.tool ?? ""));
        reason = String(parsed.reason ?? "").trim();
      } catch {
        // Fall through to the "no JSON / bad JSON" handler below
      }
    }
    // If no parseable JSON but the model clearly gave a conversational answer,
    // treat that as "none" (the model chose not to use any tool). This matches
    // the intent of cases like a plain "hi" greeting.
    if (picked === "unknown") {
      const lower = text.toLowerCase();
      // Word-boundary check so substrings like "reading" don't count as "read".
      const mentionsTool = CANONICAL_TOOLS.some(t => {
        const re = new RegExp(`\\b${t.toLowerCase().replace(/_/g, "[_ ]")}\\b`);
        return re.test(lower);
      });
      if (!mentionsTool && text.trim().length > 0) {
        picked = "none";
        reason = `(no JSON — model replied conversationally: "${text.slice(0, 120).trim()}${text.length > 120 ? "…" : ""}")`;
      } else {
        return {
          id: c.id,
          task: c.task,
          expected: c.expected,
          picked: "parse_error",
          reason: text.slice(0, 200),
          pass: false,
          error: "JSON parse failed",
        };
      }
    }

    const expected = normalizeTool(c.expected);
    const alternatives = (c.allowed_alternatives ?? []).map(normalizeTool);
    const acceptable = new Set([expected, ...alternatives]);
    const pass = acceptable.has(picked);
    return { id: c.id, task: c.task, expected: c.expected, picked, reason, pass };
  } catch (err: any) {
    return {
      id: c.id,
      task: c.task,
      expected: c.expected,
      picked: "error",
      reason: "",
      pass: false,
      error: err.message,
    };
  }
}

function parseArgs(argv: string[]): { onlyId?: string; failFast: boolean; model?: string } {
  let onlyId: string | undefined;
  let failFast = false;
  let model: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") onlyId = argv[++i];
    else if (a === "--fail-fast") failFast = true;
    else if (a === "--model") model = argv[++i];
  }
  return { onlyId, failFast, model };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const skill = loadSkill();
  const cases = loadCases(args.onlyId);
  if (cases.length === 0) {
    console.error("No cases found.");
    process.exit(2);
  }
  console.log(
    `\nHanzi skill-recall eval — ${cases.length} case${cases.length === 1 ? "" : "s"}${args.model ? ` (model: ${args.model})` : ""}\n`
  );

  const results: Result[] = [];
  for (const c of cases) {
    process.stdout.write(`  … ${c.id.padEnd(22)}`);
    const r = await runCase(skill, c, args.model);
    results.push(r);
    const mark = r.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    process.stdout.write(
      `\r  ${mark} ${c.id.padEnd(22)} picked=${r.picked.padEnd(14)} expected=${c.expected}\n`
    );
    if (args.failFast && !r.pass) break;
  }

  const pass = results.filter(r => r.pass).length;
  const total = results.length;
  const pct = Math.round((pass / total) * 100);
  console.log(`\n${pass}/${total} correct (${pct}%)\n`);

  const misses = results.filter(r => !r.pass);
  if (misses.length) {
    console.log("Misses:\n");
    for (const m of misses) {
      console.log(
        `  \x1b[31m✗\x1b[0m ${m.id} — "${m.task.slice(0, 70)}${m.task.length > 70 ? "…" : ""}"`
      );
      console.log(`      expected: ${m.expected}`);
      console.log(`      picked:   ${m.picked}`);
      console.log(`      reason:   "${m.reason || m.error || ""}"`);
      console.log("");
    }
  }

  process.exit(pass === total ? 0 : 1);
}

main().catch(err => {
  console.error("Eval failed:", err);
  process.exit(2);
});
