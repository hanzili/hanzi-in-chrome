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

import { betterAuth } from "better-auth";
import pg from "pg";
import { log } from "./log.js";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || "";

// Shared pool for workspace provisioning queries (separate from Better Auth's pool)
let provisionPool: pg.Pool | null = null;

function getProvisionPool(): pg.Pool {
  if (!provisionPool) {
    provisionPool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  }
  return provisionPool;
}

// Singleton — created once, reused across all requests
let authInstance: any = null;
let authInitialized = false;

export function createAuth() {
  if (authInitialized) return authInstance;
  authInitialized = true;

  if (!DATABASE_URL) {
    log.info("No DATABASE_URL — Better Auth disabled");
    return null;
  }

  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!authSecret) {
    if (process.env.NODE_ENV === "production") {
      log.error("FATAL: BETTER_AUTH_SECRET not set — sessions lost on restart");
      process.exit(1);
    }
    log.warn("BETTER_AUTH_SECRET not set — sessions invalidated on restart");
  }

  authInstance = betterAuth({
    database: new Pool({ connectionString: DATABASE_URL, max: 5 }),
    secret: authSecret,
    baseURL: process.env.BETTER_AUTH_URL || "https://api.hanzilla.co",
    emailAndPassword: {
      enabled: true,
    },
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID || "",
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
      },
    },
    basePath: "/api/auth",
    trustedOrigins: [
      "https://browse.hanzilla.co",
      "https://api.hanzilla.co",
      "http://localhost:3000",
      "http://localhost:3456",
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user: any) => {
            // Auto-provision workspace when a new user is created
            const userId = user.id;
            if (!userId) return;

            const client = await getProvisionPool().connect();
            try {
              await client.query("BEGIN");
              const wsRes = await client.query(
                "INSERT INTO workspaces (name) VALUES ($1) RETURNING id",
                [`${user.name || "My"}'s Workspace`]
              );
              const workspaceId = wsRes.rows[0].id;
              await client.query(
                "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
                [workspaceId, userId]
              );
              await client.query("COMMIT");
              log.info("Provisioned workspace", { workspaceId }, { userId });
            } catch (err: any) {
              await client.query("ROLLBACK").catch(() => {});
              log.error("Workspace provisioning error", undefined, { error: err.message });
            } finally {
              client.release();
            }
          },
        },
      },
    },
  });

  log.info("Better Auth initialized");
  return authInstance;
}

/**
 * Resolve a Better Auth session cookie to workspace info.
 * Returns { userId, workspaceId } or null.
 * Used by API endpoints that accept both API keys and session auth.
 */
export async function resolveSessionToWorkspace(
  req: import("http").IncomingMessage
): Promise<{ userId: string; workspaceId: string } | null> {
  const auth = createAuth();
  if (!auth) return null;

  try {
    // Convert Node req headers to Headers
    const headers = new Headers();
    for (const [key, val] of Object.entries(req.headers)) {
      if (val) headers.set(key, Array.isArray(val) ? val[0] : val);
    }

    const session = await auth.api.getSession({ headers });
    if (!session?.user?.id) return null;

    // Look up workspace membership
    const db = getProvisionPool();
    // If the request specifies a workspace via header, use that (for multi-workspace users)
    const requestedWs = req.headers["x-workspace-id"] as string | undefined;

    const query = requestedWs
      ? "SELECT workspace_id FROM workspace_members WHERE user_id = $1 AND workspace_id = $2 LIMIT 1"
      : "SELECT workspace_id FROM workspace_members WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1";
    const params = requestedWs ? [session.user.id, requestedWs] : [session.user.id];

    const res = await db.query(query, params);
    if (res.rows.length === 0) return null;

    return {
      userId: session.user.id,
      workspaceId: res.rows[0].workspace_id,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve session to full profile (user name, email, workspace name).
 * Used by GET /v1/me for the developer console.
 */
export async function resolveSessionProfile(
  req: import("http").IncomingMessage
): Promise<{
  userId: string;
  workspaceId: string;
  userName: string;
  userEmail: string;
  workspaceName: string;
  plan: string;
} | null> {
  const auth = createAuth();
  if (!auth) return null;

  try {
    const headers = new Headers();
    for (const [key, val] of Object.entries(req.headers)) {
      if (val) headers.set(key, Array.isArray(val) ? val[0] : val);
    }

    const session = await auth.api.getSession({ headers });
    if (!session?.user?.id) return null;

    const db = getProvisionPool();
    const res = await db.query(
      `SELECT wm.workspace_id, w.name as workspace_name, w.plan
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
       WHERE wm.user_id = $1
       ORDER BY wm.created_at ASC LIMIT 1`,
      [session.user.id]
    );
    if (res.rows.length === 0) return null;

    return {
      userId: session.user.id,
      workspaceId: res.rows[0].workspace_id,
      userName: session.user.name || "",
      userEmail: session.user.email || "",
      workspaceName: res.rows[0].workspace_name,
      plan: res.rows[0].plan || "free",
    };
  } catch {
    return null;
  }
}
