/**
 * @hanzi-browse/sdk
 *
 * Minimal client for the Hanzi Browse browser automation platform.
 *
 * Usage:
 *   import { HanziClient } from '@hanzi-browse/sdk';
 *
 *   const client = new HanziClient({
 *     apiKey: 'hic_live_xxx',
 *     baseUrl: 'https://api.hanzilla.co', // optional, this is the default
 *   });
 *
 *   // Pair a browser session
 *   const { pairingToken } = await client.createPairingToken();
 *   // Give pairingToken to the extension user...
 *
 *   // Run a task
 *   const result = await client.runTask({
 *     browserSessionId: 'xxx',
 *     task: 'Go to example.com and read the title',
 *   });
 *   console.log(result.answer);
 */

// --- Types ---

export interface HanziClientOptions {
  apiKey: string;
  baseUrl?: string;
}

export interface TaskCreateParams {
  browserSessionId: string;
  task: string;
  url?: string;
  context?: string;
  /** URL to receive a POST when the task completes or fails. */
  webhookUrl?: string;
}

export interface TaskRun {
  id: string;
  status: "running" | "complete" | "error" | "cancelled";
  task: string;
  answer?: string;
  steps: number;
  usage: { inputTokens: number; outputTokens: number; apiCalls: number };
  browserSessionId?: string;
  createdAt: number;
  completedAt?: number;
  turns?: Array<{
    step: number;
    tools: Array<{ name: string; input: Record<string, any>; result: string; durationMs: number }>;
    ai_response: string | null;
  }>;
}

export interface BrowserSession {
  id: string;
  status: "connected" | "disconnected";
  connectedAt: number;
  lastHeartbeat: number;
  label?: string;
  externalUserId?: string;
}

export interface PairingTokenResponse {
  pairingToken: string;
  expiresAt: number;
  expiresInSeconds: number;
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalApiCalls: number;
  totalCostUsd: number;
  taskCount: number;
}

export interface TaskStep {
  step: number;
  status: string;
  toolName?: string;
  toolInput?: any;
  output?: string;
  screenshot?: string;
  createdAt?: number;
  durationMs?: number;
}

export interface CreditBalance {
  freeRemaining: number;
  creditBalance: number;
  freeTasksPerMonth: number;
}

// --- Client ---

export class HanziClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(options: HanziClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || "https://api.hanzilla.co").replace(
      /\/$/,
      ""
    );
  }

  private async request(
    method: string,
    path: string,
    body?: any
  ): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    let data: any;
    try {
      data = await res.json();
    } catch {
      throw new HanziError(
        `HTTP ${res.status} (non-JSON response)`,
        res.status
      );
    }

    if (!res.ok) {
      throw new HanziError(
        data.error || `HTTP ${res.status}`,
        res.status,
        data
      );
    }

    return data;
  }

  // --- Browser Sessions ---

  /** Create a pairing token. Give this to the extension user to connect their browser. */
  async createPairingToken(options?: {
    label?: string;
    externalUserId?: string;
  }): Promise<PairingTokenResponse> {
    const body: any = {};
    if (options?.label) body.label = options.label;
    if (options?.externalUserId) body.external_user_id = options.externalUserId;
    const data = await this.request("POST", "/v1/browser-sessions/pair", Object.keys(body).length ? body : undefined);
    return {
      pairingToken: data.pairing_token,
      expiresAt: data.expires_at,
      expiresInSeconds: data.expires_in_seconds,
    };
  }

  /** List all browser sessions for your workspace. */
  async listSessions(): Promise<BrowserSession[]> {
    const data = await this.request("GET", "/v1/browser-sessions");
    return data.sessions.map((s: any) => ({
      id: s.id,
      status: s.status,
      connectedAt: s.connected_at ?? s.connectedAt,
      lastHeartbeat: s.last_heartbeat ?? s.lastHeartbeat,
      label: s.label || undefined,
      externalUserId: (s.external_user_id ?? s.externalUserId) || undefined,
    }));
  }

  /** Delete a browser session. The user will need to re-pair. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.request("DELETE", `/v1/browser-sessions/${sessionId}`);
  }

  // --- Tasks ---

  /** Start a task. Returns immediately with the task ID. */
  async createTask(params: TaskCreateParams): Promise<TaskRun> {
    const data = await this.request("POST", "/v1/tasks", {
      browser_session_id: params.browserSessionId,
      task: params.task,
      url: params.url,
      context: params.context,
      webhook_url: params.webhookUrl,
    });
    return this.normalizeTask(data);
  }

  /** Get the current status of a task. */
  async getTask(taskId: string): Promise<TaskRun> {
    const data = await this.request("GET", `/v1/tasks/${taskId}`);
    return this.normalizeTask(data);
  }

  /** Cancel a running task. */
  async cancelTask(taskId: string): Promise<void> {
    await this.request("POST", `/v1/tasks/${taskId}/cancel`);
  }

  /** List recent tasks for your workspace. */
  async listTasks(): Promise<TaskRun[]> {
    const data = await this.request("GET", "/v1/tasks");
    return data.tasks.map((t: any) => this.normalizeTask(t));
  }

  /** Get the execution timeline for a task. Useful for debugging. */
  async getTaskSteps(taskId: string): Promise<TaskStep[]> {
    const data = await this.request("GET", `/v1/tasks/${taskId}/steps`);
    return (data.steps || []).map((s: any) => ({
      step: s.step,
      status: s.status,
      toolName: s.tool_name ?? s.toolName,
      toolInput: s.tool_input ?? s.toolInput,
      output: s.output,
      screenshot: s.screenshot,
      createdAt: s.created_at ?? s.createdAt,
      durationMs: s.duration_ms ?? s.durationMs,
    }));
  }

  /** Get the screenshot captured at a specific step of a task. Returns base64 JPEG data. */
  async getScreenshot(taskId: string, step: number): Promise<string> {
    const data = await this.request("GET", `/v1/tasks/${taskId}/screenshots/${step}`);
    return data.screenshot;
  }

  /**
   * Run a task and wait for completion. Polls until the task finishes.
   * This is the main method most integrations should use.
   */
  async runTask(
    params: TaskCreateParams,
    options?: { pollIntervalMs?: number; timeoutMs?: number }
  ): Promise<TaskRun> {
    const pollInterval = options?.pollIntervalMs || 2000;
    const timeout = options?.timeoutMs || 5 * 60 * 1000;
    const deadline = Date.now() + timeout;

    const task = await this.createTask(params);

    let consecutiveErrors = 0;
    while (Date.now() < deadline) {
      await sleep(pollInterval);
      try {
        const current = await this.getTask(task.id);
        consecutiveErrors = 0;
        if (current.status !== "running") {
          return current;
        }
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= 3) throw err; // persistent failure, give up
        // transient error — retry on next poll
      }
    }

    // Timeout — cancel and return
    try {
      await this.cancelTask(task.id);
    } catch {}
    return this.getTask(task.id);
  }

  // --- API Keys ---

  /** Create a new API key. Returns the full key — store it, it won't be shown again. */
  async createApiKey(name: string, type?: "secret" | "publishable"): Promise<{ id: string; key: string; name: string; type: string }> {
    const data = await this.request("POST", "/v1/api-keys", { name, type });
    return { id: data.id, key: data.key, name: data.name, type: data.type };
  }

  /** List all API keys for your workspace. Keys are shown as prefixes only. */
  async listApiKeys(): Promise<{ id: string; keyPrefix: string; name: string; createdAt: number }[]> {
    const data = await this.request("GET", "/v1/api-keys");
    return (data.keys || []).map((k: any) => ({
      id: k.id,
      keyPrefix: k.key_prefix ?? k.keyPrefix,
      name: k.name,
      createdAt: k.created_at ?? k.createdAt,
    }));
  }

  /** Delete an API key. */
  async deleteApiKey(keyId: string): Promise<void> {
    await this.request("DELETE", `/v1/api-keys/${keyId}`);
  }

  // --- Usage ---

  /** Get usage summary for your workspace. */
  async getUsage(): Promise<UsageSummary> {
    const data = await this.request("GET", "/v1/usage");
    return {
      totalInputTokens: data.total_input_tokens ?? data.totalInputTokens ?? 0,
      totalOutputTokens: data.total_output_tokens ?? data.totalOutputTokens ?? 0,
      totalApiCalls: data.total_api_calls ?? data.totalApiCalls ?? 0,
      totalCostUsd: data.total_cost_usd ?? data.totalCostUsd ?? 0,
      taskCount: data.task_count ?? data.taskCount ?? 0,
    };
  }

  /** Get credit balance and free tier status. */
  async getCredits(): Promise<CreditBalance> {
    const data = await this.request("GET", "/v1/billing/credits");
    return {
      freeRemaining: data.free_remaining,
      creditBalance: data.credit_balance,
      freeTasksPerMonth: data.free_tasks_per_month,
    };
  }

  // --- Health ---

  /** Check if the API is reachable. Does not require auth. */
  async health(): Promise<{ status: string; relayConnected: boolean }> {
    const data = await this.request("GET", "/v1/health");
    return {
      status: data.status,
      relayConnected: data.relay_connected ?? data.relayConnected,
    };
  }

  // --- Helpers ---

  private normalizeTask(data: any): TaskRun {
    const usage = data.usage || {};
    return {
      id: data.id,
      status: data.status,
      task: data.task,
      answer: data.answer,
      steps: data.steps || 0,
      usage: {
        inputTokens: usage.inputTokens ?? usage.input_tokens ?? 0,
        outputTokens: usage.outputTokens ?? usage.output_tokens ?? 0,
        apiCalls: usage.apiCalls ?? usage.api_calls ?? 0,
      },
      browserSessionId: data.browser_session_id ?? data.browserSessionId,
      createdAt: data.created_at ?? data.createdAt,
      completedAt: data.completed_at ?? data.completedAt,
      turns: data.turns || undefined,
    };
  }
}

// --- Error ---

export class HanziError extends Error {
  status: number;
  data: any;

  constructor(message: string, status: number, data?: any) {
    super(message);
    this.name = "HanziError";
    this.status = status;
    this.data = data;
  }
}

// --- Util ---

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
