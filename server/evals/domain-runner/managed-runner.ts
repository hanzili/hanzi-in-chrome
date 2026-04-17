/**
 * Managed-API task runner for the golden-task eval harness.
 *
 * Unlike the local relay runner (which drives runAgentLoop in-process and
 * routes tool calls through ws://localhost:7862), this runner POSTs the whole
 * task to api.hanzilla.co and polls for the result. It's the honest
 * end-to-end path for CI against prod.
 *
 * Protocol reference: server/src/managed/routes/api.ts (POST /v1/tasks,
 * GET /v1/tasks/:id, GET /v1/tasks/:id/steps).
 */

import type { TurnLog } from "../../src/agent/loop.js";
import type { GoldenCase, CaseResult, SuccessCheck } from "./types.js";
import { findForbiddenCall, findRequiredCall } from "./check-tool-calls.js";
import { judgeScreenshot, judgeAnswer } from "./llm-judge.js";

export interface ManagedRunnerOptions {
  apiUrl: string;              // e.g. https://api.hanzilla.co
  apiKey: string;              // hic_live_...
  browserSessionId: string;    // UUID of a connected browser session
  pollIntervalMs?: number;     // default 2000
  /** Fetch impl (injected for tests). */
  fetchImpl?: typeof fetch;
}

interface ApiStep {
  step: number;
  status: "thinking" | "tool_use" | "tool_output";
  toolName: string | null;
  toolInput: Record<string, any> | null;
  output?: string | Record<string, any>;
  durationMs: number | null;
}

/**
 * Pair `tool_use` records with their matching `tool_output` for the same step
 * and collapse into the TurnLog shape the matchers already understand.
 */
export function stepsToTurnLogs(steps: ApiStep[]): TurnLog[] {
  const byStep = new Map<number, TurnLog>();

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!byStep.has(s.step)) {
      byStep.set(s.step, { step: s.step, ai_response: null, tools: [] });
    }
    if (s.status !== "tool_use" || !s.toolName) continue;

    // Find the matching tool_output (same step + toolName, after this index).
    let result = "";
    let durationMs = s.durationMs ?? 0;
    for (let j = i + 1; j < Math.min(i + 6, steps.length); j++) {
      const ns = steps[j];
      if (ns.status === "tool_output" && ns.step === s.step && ns.toolName === s.toolName) {
        result = typeof ns.output === "string"
          ? ns.output
          : JSON.stringify(ns.output ?? "");
        durationMs = ns.durationMs ?? durationMs;
        break;
      }
    }

    byStep.get(s.step)!.tools.push({
      name: s.toolName,
      input: s.toolInput ?? {},
      result,
      durationMs,
    });
  }

  return Array.from(byStep.values()).sort((a, b) => a.step - b.step);
}

async function checkSuccess(
  check: SuccessCheck,
  answer: string,
  finalScreenshot: { data: string; mediaType: string } | null
): Promise<{ pass: boolean; reason: string }> {
  if (check.type === "agent_answer_contains") {
    const pass = answer.includes(check.substring);
    return {
      pass,
      reason: pass
        ? ""
        : `answer did not contain "${check.substring}" — got: ${answer.slice(0, 120) || "(empty)"}`,
    };
  }
  if (check.type === "llm_judge") {
    const j = finalScreenshot
      ? await judgeScreenshot({ screenshot: finalScreenshot, prompt: check.prompt })
      : await judgeAnswer({ answer, prompt: check.prompt });
    return {
      pass: j.pass,
      reason: j.pass ? "" : `judge answered: "${j.rawAnswer}" (judged ${finalScreenshot ? "screenshot" : "answer text"})`,
    };
  }
  return { pass: false, reason: "unknown success_check type" };
}

async function poll<T>(
  f: () => Promise<T>,
  done: (r: T) => boolean,
  intervalMs: number,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await f();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await f();
  }
  return last;
}

export async function runCaseManaged(
  domain: string,
  c: GoldenCase,
  opts: ManagedRunnerOptions
): Promise<CaseResult> {
  const start = Date.now();
  const reasons: string[] = [];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = (c.timeout_sec ?? 120) * 1000;
  const headers = {
    "Authorization": `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
  };

  // 1. Create the task.
  let createRes: Response;
  try {
    createRes = await fetchImpl(`${opts.apiUrl}/v1/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        task: c.task,
        url: c.url,
        context: c.context,
        browser_session_id: opts.browserSessionId,
      }),
    });
  } catch (e: any) {
    return {
      domain, caseId: c.id, pass: false,
      reasons: [`fetch failed: ${e.message}`],
      steps: 0, durationMs: Date.now() - start, error: e.message,
    };
  }

  if (!createRes.ok) {
    const body = await createRes.text();
    return {
      domain, caseId: c.id, pass: false,
      reasons: [`POST /v1/tasks returned ${createRes.status}: ${body.slice(0, 200)}`],
      steps: 0, durationMs: Date.now() - start, error: `http_${createRes.status}`,
    };
  }

  const created = await createRes.json();
  const taskId = created.id as string;

  // 2. Poll until terminal.
  const final = await poll(
    async () => {
      const r = await fetchImpl(`${opts.apiUrl}/v1/tasks/${taskId}`, { headers });
      return await r.json();
    },
    (r) => r.status && r.status !== "running",
    opts.pollIntervalMs ?? 2000,
    timeoutMs
  );

  if (!final.status || final.status === "running") {
    return {
      domain, caseId: c.id, pass: false,
      reasons: [`task ${taskId} still running after ${timeoutMs}ms poll deadline`],
      steps: final.steps ?? 0, durationMs: Date.now() - start,
      error: "poll_timeout",
    };
  }

  // 3. Fetch per-step trace for forbidden/required assertions.
  let turns: TurnLog[] = [];
  try {
    const stepsRes = await fetchImpl(`${opts.apiUrl}/v1/tasks/${taskId}/steps`, { headers });
    if (stepsRes.ok) {
      const stepsJson = await stepsRes.json();
      turns = stepsToTurnLogs(stepsJson.steps ?? []);
    }
  } catch {
    // Non-fatal — tool-call assertions will just be skipped below.
  }

  // 4. If the success_check is llm_judge, fetch the final available screenshot.
  // Screenshots are captured by some tools (computer actions, explicit captures),
  // so walk backwards from the last step until we find one. 404 = no screenshot
  // at that step — keep going.
  let finalScreenshot: { data: string; mediaType: string } | null = null;
  if (c.success_check.type === "llm_judge") {
    const totalSteps = (final.steps as number) ?? 0;
    for (let step = totalSteps; step >= 1 && !finalScreenshot; step--) {
      try {
        const r = await fetchImpl(
          `${opts.apiUrl}/v1/tasks/${taskId}/screenshots/${step}`,
          { headers }
        );
        if (!r.ok) continue;
        const body = await r.json() as { screenshot?: string | { data?: string; mediaType?: string } };
        if (!body.screenshot) continue;
        if (typeof body.screenshot === "string") {
          finalScreenshot = { data: body.screenshot, mediaType: "image/jpeg" };
        } else if (body.screenshot.data) {
          finalScreenshot = {
            data: body.screenshot.data,
            mediaType: body.screenshot.mediaType ?? "image/jpeg",
          };
        }
      } catch {
        // Keep walking backward.
      }
    }
  }

  if (c.forbidden_tool_call) {
    const hit = findForbiddenCall(turns, c.forbidden_tool_call);
    if (hit) {
      reasons.push(
        `forbidden_tool_call matched at step ${hit.step} (tool=${c.forbidden_tool_call.tool})`
      );
    }
  }
  if (c.required_tool_call) {
    const hit = findRequiredCall(turns, c.required_tool_call);
    if (!hit) {
      reasons.push(
        `required_tool_call not found (tool=${c.required_tool_call.tool})`
      );
    }
  }

  const answer = (final.answer as string) ?? "";
  const succ = await checkSuccess(c.success_check, answer, finalScreenshot);
  if (!succ.pass) reasons.push(`success_check failed: ${succ.reason}`);

  return {
    domain,
    caseId: c.id,
    pass: reasons.length === 0,
    reasons,
    steps: (final.steps as number) ?? 0,
    durationMs: Date.now() - start,
    answer,
    error: final.error,
  };
}
