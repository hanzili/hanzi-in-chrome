/**
 * LLM Client for MCP Server
 *
 * Routes between providers:
 * - Vertex AI (Gemini) — managed mode, server-side agent loop
 * - Anthropic — legacy local mode, Claude Code OAuth
 *
 * Canonical internal format is Anthropic content blocks.
 * Vertex provider converts at the API boundary.
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
    /** The model that produced this response (for billing attribution) */
    model?: string;
    /** Raw Gemini response parts — preserves thought signatures for Gemini 3+ */
    _rawGeminiParts?: any[];
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
 * Call the LLM. Routes to Vertex AI (Gemini) if configured, otherwise Anthropic.
 *
 * Handles streaming, auto-refresh on 401, and credential resolution.
 */
export declare function callLLM(params: CallLLMParams): Promise<LLMResponse>;
/**
 * Reset cached credentials (e.g., after manual credential update).
 */
export declare function resetCredentialCache(): void;
