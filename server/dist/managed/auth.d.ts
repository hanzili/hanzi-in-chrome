/**
 * Better Auth Configuration
 *
 * Human auth for the managed platform.
 * - Google sign-in (default)
 * - Email/password (fallback)
 * - Session management
 * - Linked to Hanzi workspace model
 *
 * Better Auth handles: user accounts, sessions, OAuth.
 * Hanzi handles: workspaces, API keys, browser sessions, tasks, billing.
 */
export declare function createAuth(): any;
/**
 * Resolve a Better Auth session cookie to workspace info.
 * Returns { userId, workspaceId } or null.
 * Used by API endpoints that accept both API keys and session auth.
 */
export declare function resolveSessionToWorkspace(req: import("http").IncomingMessage): Promise<{
    userId: string;
    workspaceId: string;
} | null>;
/**
 * Resolve session to full profile (user name, email, workspace name).
 * Used by GET /v1/me for the developer console.
 */
export declare function resolveSessionProfile(req: import("http").IncomingMessage): Promise<{
    userId: string;
    workspaceId: string;
    userName: string;
    userEmail: string;
    workspaceName: string;
    plan: string;
} | null>;
