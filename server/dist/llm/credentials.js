/**
 * Credential Reader for MCP Server
 *
 * Reads Claude/Codex credentials directly from the user's machine,
 * eliminating the need for the native host bridge in MCP mode.
 *
 * Resolution order:
 * 1. ANTHROPIC_API_KEY env var → direct API key auth
 * 2. ~/.claude/.credentials.json → Claude Code OAuth tokens
 * 3. macOS Keychain "Claude Code-credentials" → Claude Code OAuth tokens
 * 4. ~/.codex/auth.json → Codex/OpenAI tokens
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
// OAuth configuration (same as native-bridge.cjs)
const OAUTH_CONFIG = {
    tokenUrl: "https://console.anthropic.com/v1/oauth/token",
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
};
/**
 * Read Claude Code OAuth credentials from ~/.claude/.credentials.json
 */
export function getClaudeCredentials() {
    const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
    if (!fs.existsSync(credPath))
        return null;
    try {
        const content = fs.readFileSync(credPath, "utf8");
        const creds = JSON.parse(content);
        if (creds.claudeAiOauth?.accessToken) {
            return creds.claudeAiOauth;
        }
    }
    catch {
        // File unreadable or invalid JSON
    }
    return null;
}
/**
 * Read Claude Code credentials from macOS Keychain
 */
export function getClaudeKeychainCredentials() {
    if (process.platform !== "darwin")
        return null;
    try {
        const result = execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
        if (result?.trim()) {
            const creds = JSON.parse(result.trim());
            if (creds.claudeAiOauth?.accessToken) {
                return creds.claudeAiOauth;
            }
        }
    }
    catch {
        // Keychain entry not found or not on macOS
    }
    return null;
}
/**
 * Read Codex CLI credentials from ~/.codex/auth.json
 */
export function getCodexCredentials() {
    const credPath = path.join(os.homedir(), ".codex", "auth.json");
    if (!fs.existsSync(credPath))
        return null;
    try {
        const content = fs.readFileSync(credPath, "utf8");
        const creds = JSON.parse(content);
        if (creds.tokens?.access_token) {
            return {
                accessToken: creds.tokens.access_token,
                refreshToken: creds.tokens.refresh_token,
                accountId: creds.tokens.account_id,
            };
        }
    }
    catch {
        // File unreadable or invalid JSON
    }
    return null;
}
/**
 * Save refreshed Claude credentials back to ~/.claude/.credentials.json
 */
export function saveClaudeCredentials(newCreds) {
    const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
    try {
        let existingData = {};
        if (fs.existsSync(credPath)) {
            existingData = JSON.parse(fs.readFileSync(credPath, "utf8"));
        }
        existingData.claudeAiOauth = {
            ...existingData.claudeAiOauth,
            accessToken: newCreds.accessToken,
            refreshToken: newCreds.refreshToken || existingData.claudeAiOauth?.refreshToken,
            expiresAt: newCreds.expiresAt,
        };
        fs.writeFileSync(credPath, JSON.stringify(existingData, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Refresh Claude OAuth token using refresh token
 */
export async function refreshClaudeToken(refreshToken) {
    const body = JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CONFIG.clientId,
    });
    const response = await fetch(OAUTH_CONFIG.tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
        },
        body,
    });
    if (response.ok) {
        const data = await response.json();
        const expiresAt = Date.now() + data.expires_in * 1000;
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || refreshToken,
            expiresAt,
        };
    }
    // Parse error for actionable message
    let errorMessage = `Token refresh failed (${response.status})`;
    try {
        const errorData = await response.json();
        const oauthError = errorData.error || errorData.error_code;
        switch (oauthError) {
            case "invalid_grant":
                errorMessage = "Refresh token expired or revoked. Run: claude login";
                break;
            case "invalid_client":
                errorMessage = "OAuth client configuration error.";
                break;
            default:
                errorMessage = errorData.error_description || `OAuth error: ${oauthError || response.status}`;
        }
    }
    catch {
        if (response.status === 400)
            errorMessage = "Refresh token invalid. Run: claude login";
        else if (response.status >= 500)
            errorMessage = "Anthropic API error. Try again later.";
    }
    throw new Error(errorMessage);
}
/**
 * Resolve credentials in priority order.
 * Returns the first valid credential source found.
 */
export function resolveCredentials() {
    // 1. ANTHROPIC_API_KEY env var
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
        return { type: "api_key", apiKey };
    }
    // 2. Claude Code credentials file
    const fileCreds = getClaudeCredentials();
    if (fileCreds) {
        return { type: "claude_oauth", credentials: fileCreds };
    }
    // 3. macOS Keychain
    const keychainCreds = getClaudeKeychainCredentials();
    if (keychainCreds) {
        return { type: "claude_oauth", credentials: keychainCreds };
    }
    // 4. Codex credentials
    const codexCreds = getCodexCredentials();
    if (codexCreds) {
        return { type: "codex_oauth", credentials: codexCreds };
    }
    return null;
}
/**
 * Get a human-readable description of the credential source found.
 */
export function describeCredentials() {
    const source = resolveCredentials();
    if (!source) {
        return "No credentials found. Set ANTHROPIC_API_KEY or run `claude login`";
    }
    switch (source.type) {
        case "api_key":
            return "Found ANTHROPIC_API_KEY";
        case "claude_oauth":
            return "Found Claude Code credentials";
        case "codex_oauth":
            return "Found Codex credentials";
    }
}
