/**
 * @hanzi/browser-agent SDK
 *
 * Minimal client for the Hanzi browser automation platform.
 *
 * Usage:
 *   import { HanziClient } from '@hanzi/browser-agent';
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
    usage: {
        inputTokens: number;
        outputTokens: number;
        apiCalls: number;
    };
    browserSessionId?: string;
    createdAt: number;
    completedAt?: number;
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
export declare class HanziClient {
    private apiKey;
    private baseUrl;
    constructor(options: HanziClientOptions);
    private request;
    /** Create a pairing token. Give this to the extension user to connect their browser. */
    createPairingToken(options?: {
        label?: string;
        externalUserId?: string;
    }): Promise<PairingTokenResponse>;
    /** List all browser sessions for your workspace. */
    listSessions(): Promise<BrowserSession[]>;
    /** Delete a browser session. The user will need to re-pair. */
    deleteSession(sessionId: string): Promise<void>;
    /** Start a task. Returns immediately with the task ID. */
    createTask(params: TaskCreateParams): Promise<TaskRun>;
    /** Get the current status of a task. */
    getTask(taskId: string): Promise<TaskRun>;
    /** Cancel a running task. */
    cancelTask(taskId: string): Promise<void>;
    /** List recent tasks for your workspace. */
    listTasks(): Promise<TaskRun[]>;
    /** Get the execution timeline for a task. Useful for debugging. */
    getTaskSteps(taskId: string): Promise<TaskStep[]>;
    /** Get the screenshot captured at a specific step of a task. Returns base64 JPEG data. */
    getScreenshot(taskId: string, step: number): Promise<string>;
    /**
     * Run a task and wait for completion. Polls until the task finishes.
     * This is the main method most integrations should use.
     */
    runTask(params: TaskCreateParams, options?: {
        pollIntervalMs?: number;
        timeoutMs?: number;
    }): Promise<TaskRun>;
    /** Create a new API key. Returns the full key — store it, it won't be shown again. */
    createApiKey(name?: string): Promise<{
        id: string;
        key: string;
        name: string;
    }>;
    /** List all API keys for your workspace. Keys are shown as prefixes only. */
    listApiKeys(): Promise<{
        id: string;
        keyPrefix: string;
        name: string;
        createdAt: number;
    }[]>;
    /** Delete an API key. */
    deleteApiKey(keyId: string): Promise<void>;
    /** Get usage summary for your workspace. */
    getUsage(): Promise<UsageSummary>;
    /** Get credit balance and free tier status. */
    getCredits(): Promise<CreditBalance>;
    /** Check if the API is reachable. Does not require auth. */
    health(): Promise<{
        status: string;
        relayConnected: boolean;
    }>;
    private normalizeTask;
}
export declare class HanziError extends Error {
    status: number;
    data: any;
    constructor(message: string, status: number, data?: any);
}
