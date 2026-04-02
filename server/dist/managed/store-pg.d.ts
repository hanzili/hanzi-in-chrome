/**
 * Postgres-backed Managed Platform Store
 *
 * Drop-in replacement for store.ts (file-based).
 * Uses Neon Postgres via the `pg` driver.
 * Same exported function signatures — swap by changing the import.
 */
export interface ApiKey {
    id: string;
    key: string;
    keyPrefix?: string;
    name: string;
    workspaceId: string;
    createdAt: number;
    lastUsedAt?: number;
    type?: "secret" | "publishable";
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
export interface PairingToken {
    token: string;
    workspaceId: string;
    createdBy: string;
    createdAt: number;
    expiresAt: number;
    consumed: boolean;
    label?: string;
    externalUserId?: string;
}
export interface BrowserSession {
    id: string;
    workspaceId: string;
    sessionToken: string;
    status: "connected" | "disconnected";
    connectedAt: number;
    lastHeartbeat: number;
    tabId?: number;
    windowId?: number;
    label?: string;
    externalUserId?: string;
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
    webhookUrl?: string;
    turns?: any[];
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
export declare function initPgStore(connectionString: string): void;
export declare function createWorkspace(name: string): Promise<Workspace>;
export declare function getWorkspace(id: string): Promise<Workspace | null>;
export declare function updateWorkspaceBilling(id: string, fields: {
    stripeCustomerId?: string;
    plan?: Workspace["plan"];
    subscriptionId?: string;
    subscriptionStatus?: Workspace["subscriptionStatus"];
}): Promise<Workspace | null>;
export interface TaskAllowance {
    allowed: boolean;
    reason?: string;
    source?: "free" | "credits";
    freeRemaining?: number;
    creditBalance?: number;
}
/**
 * Check if a workspace can run a task. Returns allowance with source info.
 * Automatically resets the free tier counter on new month.
 */
export declare function checkTaskAllowance(workspaceId: string): Promise<TaskAllowance>;
/**
 * Deduct for a completed task. Call ONLY on status="complete".
 * Uses atomic SQL to prevent double-deduct races.
 */
export declare function deductTaskCredit(workspaceId: string): Promise<"free" | "credits">;
/**
 * Add purchased credits to a workspace.
 */
export declare function addCredits(workspaceId: string, amount: number): Promise<number>;
export declare function createApiKey(workspaceId: string, name: string, type?: "secret" | "publishable"): Promise<ApiKey>;
export declare function validateApiKey(key: string): Promise<ApiKey | null>;
export declare function listApiKeys(workspaceId: string): Promise<ApiKey[]>;
export declare function deleteApiKey(id: string, workspaceId: string): Promise<boolean>;
export declare function createPairingToken(workspaceId: string, apiKeyId: string | null, metadata?: {
    label?: string;
    externalUserId?: string;
}): Promise<PairingToken & {
    _plainToken: string;
}>;
export declare function consumePairingToken(pairingTokenStr: string): Promise<BrowserSession | null>;
export declare function validateSessionToken(sessionToken: string): Promise<BrowserSession | null>;
export declare function heartbeatSession(id: string): Promise<boolean>;
/**
 * Rotate a session's token. Returns the new plaintext token, or null if session is invalid.
 * The old token hash is atomically replaced. One-step rotation — no dual-token window.
 */
export declare function rotateSessionToken(id: string): Promise<string | null>;
export declare function disconnectSession(id: string): Promise<void>;
export declare function updateSessionContext(id: string, tabId: number, windowId?: number): Promise<void>;
export declare function getBrowserSession(id: string): Promise<BrowserSession | null>;
export declare function listBrowserSessions(workspaceId?: string): Promise<BrowserSession[]>;
export declare function deleteBrowserSession(id: string, workspaceId: string): Promise<boolean>;
export declare function createTaskRun(params: {
    workspaceId: string;
    apiKeyId: string;
    task: string;
    url?: string;
    context?: string;
    browserSessionId?: string;
    webhookUrl?: string;
}): Promise<TaskRun>;
export declare function updateTaskRun(id: string, updates: Partial<TaskRun>): Promise<TaskRun | null>;
export declare function getTaskRun(id: string): Promise<TaskRun | null>;
export declare function listStuckTasks(maxAgeMs: number): Promise<TaskRun[]>;
export declare function listTaskRuns(workspaceId: string, limit?: number): Promise<TaskRun[]>;
export interface TaskStep {
    id: string;
    taskRunId: string;
    step: number;
    status: string;
    toolName?: string;
    toolInput?: Record<string, any>;
    output?: string;
    screenshot?: string;
    createdAt: number;
    durationMs?: number;
}
export declare function insertTaskStep(params: {
    taskRunId: string;
    step: number;
    status: string;
    toolName?: string;
    toolInput?: Record<string, any>;
    output?: string;
    screenshot?: string;
    durationMs?: number;
}): Promise<void>;
export declare function getTaskSteps(taskRunId: string): Promise<TaskStep[]>;
export declare function getTaskStepScreenshot(taskRunId: string, step: number): Promise<string | null>;
export declare function recordUsage(params: {
    workspaceId: string;
    apiKeyId: string;
    taskRunId: string;
    inputTokens: number;
    outputTokens: number;
    apiCalls: number;
    model: string;
}): Promise<UsageEvent>;
export declare function getUsageSummary(workspaceId: string, since?: number): Promise<{
    totalInputTokens: number;
    totalOutputTokens: number;
    totalApiCalls: number;
    totalCostUsd: number;
    taskCount: number;
}>;
export declare function ensureDefaultWorkspace(): Promise<{
    workspace: Workspace;
    apiKey: ApiKey;
}>;
export interface Automation {
    id: string;
    workspaceId: string;
    browserSessionId?: string;
    type: string;
    status: "active" | "paused" | "error";
    config: Record<string, any>;
    lastRunAt?: number;
    nextRunAt?: number;
    consecutiveFailures: number;
    errorMessage?: string;
    createdAt: number;
    updatedAt: number;
}
export interface AutomationDraft {
    id: string;
    automationId: string;
    workspaceId: string;
    scoutTaskId?: string;
    batchId: string;
    status: "pending" | "approved" | "edited" | "skipped" | "posted" | "failed";
    tweetUrl: string;
    tweetText?: string;
    tweetAuthorHandle?: string;
    tweetAuthorName?: string;
    tweetAuthorBio?: string;
    tweetAuthorFollowers?: number;
    tweetEngagement?: Record<string, any>;
    tweetAgeHours?: number;
    replyText: string;
    replyType?: "A" | "B" | "C";
    replyReasoning?: string;
    score?: number;
    postTaskId?: string;
    postedAt?: number;
    editedText?: string;
    createdAt: number;
}
export interface EngagementEntry {
    id: string;
    workspaceId: string;
    automationId?: string;
    draftId?: string;
    authorHandle: string;
    replyType?: string;
    keyword?: string;
    tweetUrl?: string;
    tweetSummary?: string;
    replySummary?: string;
    postedAt: number;
}
export declare function createAutomation(params: {
    workspaceId: string;
    browserSessionId: string;
    type?: string;
    config: Record<string, any>;
    nextRunAt?: Date;
}): Promise<Automation>;
export declare function getAutomation(id: string): Promise<Automation | null>;
export declare function listAutomations(workspaceId: string): Promise<Automation[]>;
export declare function updateAutomation(id: string, workspaceId: string, fields: Partial<{
    browserSessionId: string;
    status: Automation["status"];
    config: Record<string, any>;
    lastRunAt: Date;
    nextRunAt: Date | null;
    consecutiveFailures: number;
    errorMessage: string | null;
}>): Promise<Automation | null>;
export declare function deleteAutomation(id: string, workspaceId: string): Promise<boolean>;
export declare function getDueAutomations(): Promise<Automation[]>;
export declare function createDraftBatch(params: {
    automationId: string;
    workspaceId: string;
    scoutTaskId: string;
    drafts: Array<{
        tweetUrl: string;
        tweetText?: string;
        tweetAuthorHandle?: string;
        tweetAuthorName?: string;
        tweetAuthorBio?: string;
        tweetAuthorFollowers?: number;
        tweetEngagement?: Record<string, any>;
        tweetAgeHours?: number;
        replyText: string;
        replyType?: "A" | "B" | "C";
        replyReasoning?: string;
        score?: number;
    }>;
}): Promise<AutomationDraft[]>;
export declare function listDrafts(workspaceId: string, filters?: {
    status?: string;
    automationId?: string;
    batchId?: string;
    limit?: number;
}): Promise<AutomationDraft[]>;
export declare function getDraft(id: string): Promise<AutomationDraft | null>;
export declare function updateDraft(id: string, workspaceId: string, fields: Partial<{
    status: AutomationDraft["status"];
    editedText: string;
    postTaskId: string;
    postedAt: Date;
}>): Promise<AutomationDraft | null>;
export declare function logEngagement(params: {
    workspaceId: string;
    automationId?: string;
    draftId?: string;
    authorHandle: string;
    replyType?: string;
    keyword?: string;
    tweetUrl?: string;
    tweetSummary?: string;
    replySummary?: string;
}): Promise<void>;
export declare function getRecentlyEngagedHandles(workspaceId: string, daysBack?: number): Promise<string[]>;
export declare function listEngagements(workspaceId: string, limit?: number): Promise<EngagementEntry[]>;
export declare function startHeartbeatFlush(): void;
