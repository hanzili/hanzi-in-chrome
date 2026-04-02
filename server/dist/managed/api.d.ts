/**
 * Managed API Server
 *
 * REST API for external clients to run browser tasks.
 * Enforces: API key auth, workspace ownership, browser session validation.
 *
 * Endpoints:
 *   POST   /v1/browser-sessions/pair     - Create a pairing token
 *   POST   /v1/browser-sessions/register - Exchange pairing token for session
 *   GET    /v1/browser-sessions          - List sessions for workspace
 *   POST   /v1/tasks                     - Start a task (requires browser_session_id)
 *   GET    /v1/tasks/:id                 - Get task status/result
 *   POST   /v1/tasks/:id/cancel          - Cancel a running task
 *   GET    /v1/tasks                     - List tasks for workspace
 *   GET    /v1/usage                     - Get usage summary
 *   POST   /v1/api-keys                  - Create an API key (self-serve)
 *   GET    /v1/api-keys                  - List API keys for workspace
 *   DELETE /v1/api-keys/:id              - Delete an API key
 *   GET    /v1/health                    - Health check (no auth)
 */
import { type ToolResult } from "../agent/loop.js";
import type { WebSocketClient } from "../ipc/websocket-client.js";
import * as fileStore from "./store.js";
/**
 * Swap the backing store (e.g., to Postgres). Called by deploy.ts when DATABASE_URL is set.
 */
export declare function setStoreModule(storeModule: typeof fileStore): void;
type TaskStepInsertParams = {
    taskRunId: string;
    step: number;
    status: string;
    toolName?: string;
    toolInput?: Record<string, any>;
    output?: string;
    screenshot?: string;
    durationMs?: number;
};
export declare function buildToolResultTaskSteps(params: {
    taskRunId: string;
    step: number;
    toolName: string;
    result: ToolResult;
    durationMs: number;
}): TaskStepInsertParams[];
/**
 * Startup sweep: mark any tasks still "running" from a previous process as errored.
 * Call once after store initialization.
 */
export declare function recoverStuckTasks(): Promise<void>;
/**
 * Fail all pending tool executions for a disconnected browser session.
 * Called by the relay when a managed session WebSocket closes.
 * This avoids the agent loop waiting up to 15-35s for a timeout on each tool.
 */
export declare function onSessionDisconnected(browserSessionId: string): void;
/**
 * Initialize the managed API.
 */
export declare function initManagedAPI(relay: WebSocketClient, sessionConnectedCheck?: (id: string) => boolean, actualRelayPort?: number): void;
/**
 * Handle incoming relay messages (tool results + LLM requests from extension).
 */
export declare function handleRelayMessage(message: any): boolean;
/**
 * Run a task internally (used by scheduler — no HTTP, no auth, no billing).
 * Returns a promise that resolves when the task completes.
 */
export declare function runInternalTask(params: {
    workspaceId: string;
    browserSessionId: string;
    task: string;
    url?: string;
}): Promise<{
    taskId: string;
    answer?: string;
    status: string;
}>;
export declare function startManagedAPI(port?: number): void;
/**
 * Graceful shutdown: abort all running tasks and update their status.
 * Called on SIGTERM/SIGINT to avoid leaving tasks in a permanent "running" state.
 */
export declare function shutdownManagedAPI(): Promise<void>;
export {};
