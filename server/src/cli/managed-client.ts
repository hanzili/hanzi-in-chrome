/**
 * Managed API client for Hanzi Browse CLI.
 *
 * When HANZI_API_KEY is set, tasks are routed to api.hanzilla.co instead
 * of the local relay. This module is shared by index.ts (MCP mode) and
 * cli.ts (CLI mode) so the behaviour is consistent.
 */

export const MANAGED_API_URL = process.env.HANZI_API_URL || "https://api.hanzilla.co";
export const MANAGED_API_KEY = process.env.HANZI_API_KEY;
export const IS_MANAGED_MODE = !!MANAGED_API_KEY;

export interface ManagedTaskResult {
  status: string;
  answer: string;
  steps: number;
  error?: string;
}

export interface ManagedClientOpts {
  apiUrl?: string;
  apiKey?: string;
}

export async function managedApiCall(
  method: string,
  path: string,
  body?: any,
  opts: ManagedClientOpts = {},
): Promise<any> {
  const url = opts.apiUrl ?? MANAGED_API_URL;
  const key = opts.apiKey ?? MANAGED_API_KEY;
  if (!key) throw new Error("HANZI_API_KEY not set");
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export async function runManagedTask(
  task: string,
  url?: string,
  context?: string,
  timeoutMs = 5 * 60 * 1000,
  opts: ManagedClientOpts = {},
): Promise<ManagedTaskResult> {
  const sessionsRes = await managedApiCall("GET", "/v1/browser-sessions", undefined, opts);
  const connected = sessionsRes?.sessions?.find((s: any) => s.status === "connected");
  if (!connected) {
    return {
      status: "error",
      answer: "No browser connected. Open Chrome with the Hanzi extension and pair it first.",
      steps: 0,
    };
  }

  const created = await managedApiCall(
    "POST",
    "/v1/tasks",
    { task, url, context, browser_session_id: connected.id },
    opts,
  );
  if (created.error) return { status: "error", answer: created.error, steps: 0 };

  const taskId = created.id;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const status = await managedApiCall("GET", `/v1/tasks/${taskId}`, undefined, opts);
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
