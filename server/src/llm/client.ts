/**
 * LLM Client for MCP Server
 *
 * Raw fetch to Anthropic Messages API with OAuth support.
 * Reuses header logic from native-bridge.cjs for Claude Code impersonation.
 * Auto-refreshes OAuth tokens on 401.
 */

import {
  resolveCredentials,
  refreshClaudeToken,
  saveClaudeCredentials,
  type CredentialSource,
  type ClaudeCredentials,
} from "./credentials.js";

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
  usage: { input_tokens: number; output_tokens: number };
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

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TOKENS = 16384;

// Cached credential source — refreshed on 401
let cachedSource: CredentialSource | null = null;

function getSource(): CredentialSource {
  if (!cachedSource) {
    cachedSource = resolveCredentials();
  }
  if (!cachedSource) {
    throw new Error(
      "No credentials found. Set ANTHROPIC_API_KEY or run `claude login`"
    );
  }
  return cachedSource;
}

/**
 * Build request headers based on credential type.
 */
function buildHeaders(source: CredentialSource): Record<string, string> {
  if (source.type === "api_key") {
    return {
      "Content-Type": "application/json",
      "x-api-key": source.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }

  if (source.type === "claude_oauth") {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${source.credentials.accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
      "x-app": "cli",
      "user-agent": "claude-code/2.1.29 (Darwin; arm64)",
    };
  }

  throw new Error("Codex credentials are not supported for direct LLM calls from MCP server");
}

/**
 * Parse SSE stream and extract the final response.
 */
async function parseSSEStream(
  response: Response,
  onText?: (chunk: string) => void,
  signal?: AbortSignal
): Promise<LLMResponse> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Accumulate content blocks from streaming events
  const contentBlocks: ContentBlock[] = [];
  let currentBlockIndex = -1;
  let stopReason = "";
  let usage = { input_tokens: 0, output_tokens: 0 };

  try {
    while (true) {
      if (signal?.aborted) {
        reader.cancel();
        throw new DOMException("Aborted", "AbortError");
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;

        let event: any;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        switch (event.type) {
          case "content_block_start":
            currentBlockIndex = event.index;
            if (event.content_block.type === "tool_use") {
              contentBlocks[currentBlockIndex] = {
                type: "tool_use",
                id: event.content_block.id,
                name: event.content_block.name,
                input: {},
              };
            } else if (event.content_block.type === "text") {
              contentBlocks[currentBlockIndex] = {
                type: "text",
                text: "",
              };
            }
            break;

          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              const block = contentBlocks[event.index] as ContentBlockText;
              if (block) {
                block.text += event.delta.text;
                onText?.(event.delta.text);
              }
            } else if (event.delta.type === "input_json_delta") {
              // Accumulate JSON string for tool input — parse on content_block_stop
              const block = contentBlocks[event.index] as any;
              if (block) {
                block._rawInput = (block._rawInput || "") + event.delta.partial_json;
              }
            }
            break;

          case "content_block_stop": {
            const block = contentBlocks[event.index] as any;
            if (block?.type === "tool_use") {
              if (block._rawInput) {
                try {
                  block.input = JSON.parse(block._rawInput);
                } catch {
                  block.input = {};
                }
              }
              delete block._rawInput;
            }
            break;
          }

          case "message_delta":
            if (event.delta.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            if (event.usage) {
              usage.output_tokens = event.usage.output_tokens || usage.output_tokens;
            }
            break;

          case "message_start":
            if (event.message?.usage) {
              usage.input_tokens = event.message.usage.input_tokens || 0;
            }
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Safety: strip any leftover _rawInput from tool_use blocks
  for (const block of contentBlocks) {
    if ((block as any)._rawInput !== undefined) {
      delete (block as any)._rawInput;
    }
  }

  return { content: contentBlocks, stop_reason: stopReason, usage };
}

/**
 * Call the Anthropic Messages API.
 *
 * Handles streaming, auto-refresh on 401, and credential resolution.
 */
export async function callLLM(params: CallLLMParams): Promise<LLMResponse> {
  const {
    messages,
    system,
    tools,
    model = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    signal,
    onText,
  } = params;

  const source = getSource();
  const headers = buildHeaders(source);

  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    stream: true,
  });

  let response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers,
    body,
    signal,
  });

  // Auto-refresh on 401/403 for OAuth credentials
  if (
    (response.status === 401 || response.status === 403) &&
    source.type === "claude_oauth" &&
    source.credentials.refreshToken
  ) {
    console.error("[LLM] Got 401/403, refreshing OAuth token...");
    try {
      const newCreds = await refreshClaudeToken(source.credentials.refreshToken);
      saveClaudeCredentials(newCreds);

      // Update cached source
      cachedSource = { type: "claude_oauth", credentials: newCreds };
      const newHeaders = buildHeaders(cachedSource);

      response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: newHeaders,
        body,
        signal,
      });
    } catch (refreshErr: any) {
      throw new Error(`Token refresh failed: ${refreshErr.message}`);
    }
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Anthropic API error ${response.status}: ${errorText.slice(0, 300)}`
    );
  }

  return parseSSEStream(response, onText, signal);
}

/**
 * Reset cached credentials (e.g., after manual credential update).
 */
export function resetCredentialCache(): void {
  cachedSource = null;
}
