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
export interface ClaudeCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}
export interface CodexCredentials {
    accessToken: string;
    refreshToken: string;
    accountId: string;
}
export type CredentialSource = {
    type: "api_key";
    apiKey: string;
} | {
    type: "claude_oauth";
    credentials: ClaudeCredentials;
} | {
    type: "codex_oauth";
    credentials: CodexCredentials;
};
/**
 * Read Claude Code OAuth credentials from ~/.claude/.credentials.json
 */
export declare function getClaudeCredentials(): ClaudeCredentials | null;
/**
 * Read Claude Code credentials from macOS Keychain
 */
export declare function getClaudeKeychainCredentials(): ClaudeCredentials | null;
/**
 * Read Codex CLI credentials from ~/.codex/auth.json
 */
export declare function getCodexCredentials(): CodexCredentials | null;
/**
 * Save refreshed Claude credentials back to ~/.claude/.credentials.json
 */
export declare function saveClaudeCredentials(newCreds: ClaudeCredentials): boolean;
/**
 * Refresh Claude OAuth token using refresh token
 */
export declare function refreshClaudeToken(refreshToken: string): Promise<ClaudeCredentials>;
/**
 * Resolve credentials in priority order.
 * Returns the first valid credential source found.
 */
export declare function resolveCredentials(): CredentialSource | null;
/**
 * Get a human-readable description of the credential source found.
 */
export declare function describeCredentials(): string;
