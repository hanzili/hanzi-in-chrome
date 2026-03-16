/**
 * LLM Client for MCP Server
 *
 * Raw fetch to Anthropic Messages API with OAuth support.
 * Reuses header logic from native-bridge.cjs for Claude Code impersonation.
 * Auto-refreshes OAuth tokens on 401.
 */
export interface ContentBlockText {
    type: "text";
    text: string;
}
export interface ContentBlockImage {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}
export interface ContentBlockToolUse {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, any>;
}
export interface ContentBlockToolResult {
    type: "tool_result";
    tool_use_id: string;
    content: string | Array<ContentBlockText | ContentBlockImage>;
}
export type ContentBlock = ContentBlockText | ContentBlockImage | ContentBlockToolUse | ContentBlockToolResult;
export interface Message {
    role: "user" | "assistant";
    content: string | ContentBlock[];
}
export interface Tool {
    name: string;
    description: string;
    input_schema: Record<string, any>;
}
export interface LLMResponse {
    content: ContentBlock[];
    stop_reason: string;
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
}
export interface CallLLMParams {
    messages: Message[];
    system: ContentBlockText[];
    tools: Tool[];
    model?: string;
    maxTokens?: number;
    signal?: AbortSignal;
    onText?: (chunk: string) => void;
}
/**
 * Call the Anthropic Messages API.
 *
 * Handles streaming, auto-refresh on 401, and credential resolution.
 */
export declare function callLLM(params: CallLLMParams): Promise<LLMResponse>;
/**
 * Reset cached credentials (e.g., after manual credential update).
 */
export declare function resetCredentialCache(): void;
