/**
 * Authenticated API route handlers.
 *
 * Each handler function takes the request context and returns true if it handled the request.
 * Extracted from the monolithic handleRequest() to improve readability.
 */
import { trackManagedEvent } from "../telemetry.js";
import { isBillingEnabled, createCheckoutSession } from "../billing.js";
/** Browser session routes: /v1/browser-sessions/* */
export async function handleSessionRoutes(ctx) {
    const { req, res, method, url, apiKey, S, sendJson, parseBody, isSessionConnectedFn } = ctx;
    if (method === "POST" && url === "/v1/browser-sessions/pair") {
        const body = await parseBody(req);
        const label = typeof body.label === "string" ? body.label.slice(0, 200) : undefined;
        const externalUserId = typeof body.external_user_id === "string" ? body.external_user_id.slice(0, 200) : undefined;
        const token = await S.createPairingToken(apiKey.workspaceId, apiKey.id, { label, externalUserId });
        trackManagedEvent("pairing_link_generated", apiKey.workspaceId);
        sendJson(req, res, 201, {
            pairing_token: token._plainToken,
            expires_at: token.expiresAt,
            expires_in_seconds: Math.round((token.expiresAt - Date.now()) / 1000),
        });
        return true;
    }
    if (method === "GET" && url === "/v1/browser-sessions") {
        const sessions = await S.listBrowserSessions(apiKey.workspaceId);
        sendJson(req, res, 200, {
            sessions: sessions.map((s) => ({
                id: s.id,
                status: isSessionConnectedFn ? (isSessionConnectedFn(s.id) ? "connected" : "disconnected") : s.status,
                connected_at: s.connectedAt,
                last_heartbeat: s.lastHeartbeat,
                label: s.label || null,
                external_user_id: s.externalUserId || null,
            })),
        });
        return true;
    }
    const sessionMatch = url?.match(/^\/v1\/browser-sessions\/([^/]+)$/);
    if (sessionMatch && method === "DELETE") {
        const sessionId = sessionMatch[1];
        const deleted = await S.deleteBrowserSession(sessionId, apiKey.workspaceId);
        if (!deleted) {
            sendJson(req, res, 404, { error: "Session not found" });
            return true;
        }
        sendJson(req, res, 200, { id: sessionId, deleted: true });
        return true;
    }
    return false;
}
/** Task routes: /v1/tasks/* */
export async function handleTaskRoutes(ctx) {
    const { req, res, method, url, apiKey, requestId, S, sendJson, parseBody, rejectPublishable, taskAborts, taskWorkspaceMap, handleCreateTask } = ctx;
    if (method === "POST" && url === "/v1/tasks") {
        if (rejectPublishable(apiKey, req, res, "create tasks"))
            return true;
        const body = await parseBody(req);
        const result = await handleCreateTask(body, apiKey, requestId);
        sendJson(req, res, result.status, result.data);
        return true;
    }
    if (method === "GET" && url === "/v1/tasks") {
        if (rejectPublishable(apiKey, req, res, "access tasks"))
            return true;
        const tasks = await S.listTaskRuns(apiKey.workspaceId);
        sendJson(req, res, 200, {
            tasks: tasks.map((r) => ({
                id: r.id, status: r.status, task: r.task, answer: r.answer,
                steps: r.steps, usage: r.usage, browser_session_id: r.browserSessionId,
                created_at: r.createdAt, completed_at: r.completedAt,
            })),
        });
        return true;
    }
    const taskMatch = url?.match(/^\/v1\/tasks\/([^/]+)(\/cancel|\/steps|\/screenshots\/(\d+))?$/);
    if (!taskMatch)
        return false;
    if (rejectPublishable(apiKey, req, res, "access tasks"))
        return true;
    const taskId = taskMatch[1];
    const run = await S.getTaskRun(taskId);
    if (!run || run.workspaceId !== apiKey.workspaceId) {
        sendJson(req, res, 404, { error: "Task not found" });
        return true;
    }
    if (method === "GET" && taskMatch[2] === "/steps") {
        const steps = await S.getTaskSteps(taskId);
        sendJson(req, res, 200, { steps });
        return true;
    }
    if (method === "GET" && taskMatch[3]) {
        const stepNum = parseInt(taskMatch[3], 10);
        const screenshot = await S.getTaskStepScreenshot(taskId, stepNum);
        if (!screenshot) {
            sendJson(req, res, 404, { error: "No screenshot at this step" });
            return true;
        }
        sendJson(req, res, 200, { screenshot });
        return true;
    }
    if (method === "GET" && !taskMatch[2]) {
        const response = {
            id: run.id, status: run.status, task: run.task, answer: run.answer,
            steps: run.steps, usage: run.usage, browser_session_id: run.browserSessionId,
            created_at: run.createdAt, completed_at: run.completedAt,
        };
        if (run.turns?.length)
            response.turns = run.turns;
        sendJson(req, res, 200, response);
        return true;
    }
    if (method === "POST" && taskMatch[2] === "/cancel") {
        if (run.status !== "running") {
            sendJson(req, res, 400, { error: "Task is not running" });
            return true;
        }
        const abort = taskAborts.get(taskId);
        if (abort)
            abort.abort();
        await S.updateTaskRun(taskId, { status: "cancelled", completedAt: Date.now() });
        taskAborts.delete(taskId);
        taskWorkspaceMap.delete(taskId);
        sendJson(req, res, 200, { id: taskId, status: "cancelled" });
        return true;
    }
    return false;
}
/** API key + usage + billing routes */
export async function handleKeyAndBillingRoutes(ctx) {
    const { req, res, method, url, apiKey, S, sendJson, parseBody, rejectPublishable } = ctx;
    // Usage
    if (method === "GET" && url === "/v1/usage") {
        if (rejectPublishable(apiKey, req, res, "access usage data"))
            return true;
        const summary = await S.getUsageSummary(apiKey.workspaceId);
        sendJson(req, res, 200, summary);
        return true;
    }
    // Create API key
    if (method === "POST" && url === "/v1/api-keys") {
        if (rejectPublishable(apiKey, req, res, "create API keys"))
            return true;
        const body = await parseBody(req);
        const name = body.name?.trim();
        if (!name || typeof name !== "string" || name.length > 100) {
            sendJson(req, res, 400, { error: "name is required (string, max 100 chars)" });
            return true;
        }
        const type = body.type === "publishable" ? "publishable" : "secret";
        const newKey = await S.createApiKey(apiKey.workspaceId, name, type);
        trackManagedEvent("api_key_created", apiKey.workspaceId);
        sendJson(req, res, 201, {
            id: newKey.id, key: newKey.key, name: newKey.name, type: newKey.type,
            created_at: newKey.createdAt, workspace_id: newKey.workspaceId,
            _warning: "Save this key now. It will not be shown again.",
        });
        return true;
    }
    // List API keys
    if (method === "GET" && url === "/v1/api-keys") {
        if (rejectPublishable(apiKey, req, res, "list API keys"))
            return true;
        const keys = await S.listApiKeys(apiKey.workspaceId);
        sendJson(req, res, 200, {
            keys: keys.map((k) => ({
                id: k.id,
                key_prefix: k.keyPrefix ? k.keyPrefix + "..." : k.key.slice(0, 12) + "...",
                name: k.name, created_at: k.createdAt, last_used_at: k.lastUsedAt,
            })),
        });
        return true;
    }
    // Delete API key
    const apiKeyMatch = url?.match(/^\/v1\/api-keys\/([^/]+)$/);
    if (apiKeyMatch && method === "DELETE") {
        if (rejectPublishable(apiKey, req, res, "delete API keys"))
            return true;
        const deleted = await S.deleteApiKey(apiKeyMatch[1], apiKey.workspaceId);
        if (!deleted) {
            sendJson(req, res, 404, { error: "API key not found" });
            return true;
        }
        sendJson(req, res, 200, { id: apiKeyMatch[1], deleted: true });
        return true;
    }
    // Billing credits
    if (method === "GET" && url === "/v1/billing/credits") {
        if (rejectPublishable(apiKey, req, res, "access billing data"))
            return true;
        const allowance = await S.checkTaskAllowance(apiKey.workspaceId);
        sendJson(req, res, 200, {
            free_remaining: allowance.freeRemaining,
            credit_balance: allowance.creditBalance,
            free_tasks_per_month: 20,
        });
        return true;
    }
    // Billing checkout
    if (method === "POST" && url === "/v1/billing/checkout") {
        if (rejectPublishable(apiKey, req, res, "access billing"))
            return true;
        if (!isBillingEnabled()) {
            sendJson(req, res, 503, { error: "Billing not configured. Contact support." });
            return true;
        }
        const body = await parseBody(req);
        const session = await createCheckoutSession({
            workspaceId: apiKey.workspaceId,
            userId: apiKey.id,
            email: body.email,
            credits: body.credits || 100,
            successUrl: body.success_url || "https://api.hanzilla.co/dashboard?checkout=success",
            cancelUrl: body.cancel_url || "https://api.hanzilla.co/dashboard?checkout=cancel",
        });
        sendJson(req, res, 200, session);
        return true;
    }
    return false;
}
