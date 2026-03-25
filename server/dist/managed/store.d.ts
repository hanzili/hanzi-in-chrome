/**
 * Managed Platform Store
 *
 * File-based persistence for MVP. Swap for Postgres/SQLite later.
 * Stores: API keys, task runs, usage events, browser sessions.
 */
export interface ApiKey {
    id: string;
    key: string;
    keyPrefix?: string;
    name: string;
    workspaceId: string;
    createdAt: number;
    lastUsedAt?: number;
}
export interface Workspace {
    id: string;
    name: string;
    createdAt: number;
    stripeCustomerId?: string;
    plan: "free" | "pro" | "enterprise";
    subscriptionId?: string;
    subscriptionStatus?: "active" | "past_due" | "cancelled";
    creditBalance: number;
    freeTasksThisMonth: number;
    freeTasksResetAt: number;
}
export interface TaskRun {
    id: string;
    workspaceId: string;
    apiKeyId: string;
    browserSessionId?: string;
    task: string;
    url?: string;
    context?: string;
    status: "running" | "complete" | "error" | "cancelled";
    answer?: string;
    steps: number;
    usage: {
        inputTokens: number;
        outputTokens: number;
        apiCalls: number;
    };
    createdAt: number;
    completedAt?: number;
}
export interface PairingToken {
    token: string;
    workspaceId: string;
    createdBy: string;
    createdAt: number;
    expiresAt: number;
    consumed: boolean;
    /** Partner-supplied human-readable label (e.g. "Dr. Smith's browser") */
    label?: string;
    /** Partner's own user identifier for mapping sessions to their users */
    externalUserId?: string;
}
export interface BrowserSession {
    id: string;
    workspaceId: string;
    sessionToken: string;
    status: "connected" | "disconnected";
    connectedAt: number;
    lastHeartbeat: number;
    expiresAt?: number;
    revoked?: boolean;
    /** The tab/window context this session owns for managed execution */
    tabId?: number;
    windowId?: number;
    /** Partner-supplied human-readable label (inherited from pairing token) */
    label?: string;
    /** Partner's own user identifier (inherited from pairing token) */
    externalUserId?: string;
}
export interface UsageEvent {
    id: string;
    workspaceId: string;
    apiKeyId: string;
    taskRunId: string;
    inputTokens: number;
    outputTokens: number;
    apiCalls: number;
    model: string;
    costUsd: number;
    createdAt: number;
}
export declare function createWorkspace(name: string): Workspace;
export declare function getWorkspace(id: string): Workspace | null;
export declare function checkTaskAllowance(_workspaceId: string): {
    allowed: boolean;
    source?: string;
    reason?: string;
    freeRemaining?: number;
    creditBalance?: number;
};
export declare function deductTaskCredit(_workspaceId: string): "free" | "credits";
export declare function addCredits(_workspaceId: string, _amount: number): number;
export declare function updateWorkspaceBilling(id: string, fields: {
    stripeCustomerId?: string;
    plan?: Workspace["plan"];
    subscriptionId?: string;
    subscriptionStatus?: Workspace["subscriptionStatus"];
}): Workspace | null;
export declare function createApiKey(workspaceId: string, name: string): ApiKey;
export declare function validateApiKey(key: string): ApiKey | null;
export declare function listApiKeys(workspaceId: string): ApiKey[];
export declare function deleteApiKey(id: string, workspaceId: string): boolean;
export declare function createTaskRun(params: {
    workspaceId: string;
    apiKeyId: string;
    task: string;
    url?: string;
    context?: string;
    browserSessionId?: string;
}): TaskRun;
export declare function updateTaskRun(id: string, updates: Partial<TaskRun>): TaskRun | null;
export declare function getTaskRun(id: string): TaskRun | null;
export declare function listStuckTasks(maxAgeMs: number): TaskRun[];
export declare function listTaskRuns(workspaceId: string, limit?: number): TaskRun[];
/**
 * Create a short-lived pairing token. The developer (via API key) requests this,
 * then gives it to the browser user. The extension exchanges it for a session token.
 * The workspace binding comes from the API key, NOT from the extension.
 */
export declare function createPairingToken(workspaceId: string, apiKeyId: string, metadata?: {
    label?: string;
    externalUserId?: string;
}): PairingToken & {
    _plainToken: string;
};
/**
 * Consume a pairing token and create a browser session.
 * Returns null if the token is invalid, expired, or already consumed.
 * The workspace is inherited from the pairing token — the extension cannot choose it.
 */
export declare function consumePairingToken(pairingTokenStr: string): BrowserSession | null;
/**
 * Validate a session token. Returns the session if valid, null otherwise.
 * This is how the relay authenticates extension connections.
 */
export declare function validateSessionToken(sessionToken: string): BrowserSession | null;
export declare function heartbeatSession(id: string): boolean;
/**
 * Rotate a session's token. Returns the new plaintext token, or null if session is invalid.
 * The old token is immediately invalidated (replaced by the new hash).
 * Call this periodically (e.g., on heartbeat from relay) to limit token exposure window.
 */
export declare function rotateSessionToken(id: string): string | null;
export declare function startHeartbeatFlush(): void;
export declare function disconnectSession(id: string): void;
export declare function updateSessionContext(id: string, tabId: number, windowId?: number): void;
export declare function getBrowserSession(id: string): BrowserSession | null;
export declare function getBrowserSessionByToken(sessionToken: string): BrowserSession | null;
export declare function listBrowserSessions(workspaceId?: string): BrowserSession[];
export declare function deleteBrowserSession(id: string, workspaceId: string): boolean;
export declare function insertTaskStep(_params: {
    taskRunId: string;
    step: number;
    status: string;
    toolName?: string;
    toolInput?: Record<string, any>;
    output?: string;
    screenshot?: string;
    durationMs?: number;
}): Promise<void>;
export declare function getTaskSteps(_taskRunId: string): Promise<any[]>;
export declare function getTaskStepScreenshot(_taskRunId: string, _step: number): Promise<string | null>;
export declare function recordUsage(params: {
    workspaceId: string;
    apiKeyId: string;
    taskRunId: string;
    inputTokens: number;
    outputTokens: number;
    apiCalls: number;
    model: string;
}): UsageEvent;
export declare function getUsageSummary(workspaceId: string, since?: number): {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalApiCalls: number;
    totalCostUsd: number;
    taskCount: number;
};
export declare function ensureDefaultWorkspace(): {
    workspace: Workspace;
    apiKey: ApiKey;
};
