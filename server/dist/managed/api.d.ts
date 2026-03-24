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
import type { WebSocketClient } from "../ipc/websocket-client.js";
import * as fileStore from "./store.js";
/**
 * Swap the backing store (e.g., to Postgres). Called by deploy.ts when DATABASE_URL is set.
 */
export declare function setStoreModule(storeModule: typeof fileStore): void;
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
export declare function initManagedAPI(relay: WebSocketClient, sessionConnectedCheck?: (id: string) => boolean): void;
/**
 * Handle incoming relay messages (tool results from extension).
 */
export declare function handleRelayMessage(message: any): boolean;
export declare function startManagedAPI(port?: number): void;
/**
 * Graceful shutdown: abort all running tasks and update their status.
 * Called on SIGTERM/SIGINT to avoid leaving tasks in a permanent "running" state.
 */
export declare function shutdownManagedAPI(): Promise<void>;
