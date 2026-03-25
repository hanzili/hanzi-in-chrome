/**
 * Vertex AI Gemini Provider for Server-Side LLM Client
 *
 * Handles:
 * - Service account JWT → OAuth token exchange
 * - Gemini API request/response format
 * - Streaming SSE parsing
 * - Anthropic ↔ Gemini format conversion (canonical internal format is Anthropic)
 *
 * The server uses Anthropic's content block format internally.
 * This module converts to/from Gemini's format at the API boundary.
 */

import { createSign } from "crypto";
import { readFileSync } from "fs";
import type {
  CallLLMParams,
  LLMResponse,
  ContentBlock,
  ContentBlockText,
  ContentBlockImage,
  ContentBlockToolUse,
  Message,
  Tool,
} from "./client.js";

// --- Config ---

interface VertexConfig {
  projectId: string;
  region: string;
  serviceAccountJson: any;
}

let vertexConfig: VertexConfig | null = null;
let cachedToken: string | null = null;
let cachedTokenExpiry = 0;

/**
 * Initialize Vertex AI with a service account JSON file path or object.
 */
export function initVertex(
  serviceAccountPathOrJson: string | object,
  region = "us-central1"
): void {
  const sa =
    typeof serviceAccountPathOrJson === "string"
      ? JSON.parse(readFileSync(serviceAccountPathOrJson, "utf8"))
      : serviceAccountPathOrJson;

  if (!sa.project_id || !sa.private_key || !sa.client_email) {
    throw new Error(
      "Invalid Vertex AI service account: missing project_id, private_key, or client_email"
    );
  }

  vertexConfig = {
    projectId: sa.project_id,
    region,
    serviceAccountJson: sa,
  };
  cachedToken = null;
  cachedTokenExpiry = 0;

  console.error(
    `[Vertex] Initialized: project=${sa.project_id} region=${region}`
  );
}

/**
 * Check if Vertex AI is configured.
 */
export function isVertexConfigured(): boolean {
  return vertexConfig !== null;
}

// --- Auth ---

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedTokenExpiry - 5 * 60 * 1000) {
    return cachedToken;
  }

  const sa = vertexConfig!.serviceAccountJson;
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  ).toString("base64url");

  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(sa.private_key, "base64url");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${header}.${payload}.${signature}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vertex AI token exchange failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + data.expires_in * 1000;

  return cachedToken!;
}

// --- Format Conversion ---

/**
 * Convert Anthropic-format messages to Gemini format.
 */
function convertMessages(messages: Message[]): any[] {
  const geminiMessages: any[] = [];
  const toolUseIdToName: Record<string, string> = {};

  for (const msg of messages) {
    const role = msg.role === "assistant" ? "model" : "user";
    const parts: any[] = [];

    if (typeof msg.content === "string") {
      parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: (block as ContentBlockText).text });
        } else if (block.type === "image") {
          const img = block as ContentBlockImage;
          parts.push({
            inlineData: {
              mimeType: img.source.media_type || "image/jpeg",
              data: img.source.data,
            },
          });
        } else if (block.type === "tool_use") {
          const tu = block as ContentBlockToolUse;
          toolUseIdToName[tu.id] = tu.name;
          parts.push({
            functionCall: { name: tu.name, args: tu.input },
          });
        } else if (block.type === "tool_result") {
          const tr = block as any;
          let responseText = tr.content;
          if (Array.isArray(tr.content)) {
            const textParts: string[] = [];
            for (const c of tr.content) {
              if (c.type === "text") {
                textParts.push(c.text);
              } else if (c.type === "image" && c.source?.data) {
                parts.push({
                  inlineData: {
                    mimeType: c.source.media_type || "image/jpeg",
                    data: c.source.data,
                  },
                });
              }
            }
            responseText = textParts.join("\n");
          }
          const functionName = toolUseIdToName[tr.tool_use_id] || "unknown";
          parts.push({
            functionResponse: {
              name: functionName,
              response: { result: responseText },
            },
          });
        }
      }
    }

    if (parts.length > 0) {
      geminiMessages.push({ role, parts });
    }
  }

  return geminiMessages;
}

/**
 * Convert Anthropic-format tools to Gemini format.
 */
function convertTools(tools: Tool[]): any[] {
  if (!tools || tools.length === 0) return [];

  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: sanitizeSchema(tool.input_schema),
      })),
    },
  ];
}

/**
 * Sanitize JSON Schema for Gemini (stricter than OpenAPI).
 */
function sanitizeSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const cleaned: any = {};

  if (schema.type) {
    cleaned.type = Array.isArray(schema.type) ? schema.type[0] || "string" : schema.type;
  }
  if (schema.description) cleaned.description = schema.description;
  if (schema.enum) cleaned.enum = schema.enum;
  if (schema.required) cleaned.required = schema.required;
  if (schema.properties) {
    cleaned.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      cleaned.properties[key] = sanitizeSchema(value);
    }
  }
  if (schema.items) cleaned.items = sanitizeSchema(schema.items);
  if (schema.oneOf || schema.anyOf) {
    const options = schema.oneOf || schema.anyOf;
    if (Array.isArray(options) && options.length > 0) {
      return sanitizeSchema(options[0]);
    }
  }

  return cleaned;
}

// --- Streaming ---

/**
 * Parse Gemini SSE stream into Anthropic-format LLMResponse.
 */
async function parseGeminiStream(
  response: Response,
  onText?: (chunk: string) => void,
  signal?: AbortSignal
): Promise<LLMResponse> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const content: ContentBlock[] = [];
  let currentText = "";
  const toolCalls: Array<{ id: string; name: string; input: any }> = [];
  let stopReason = "end_turn";
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

        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;

        const parts = candidate.content?.parts || [];
        for (const part of parts) {
          if (part.text) {
            currentText += part.text;
            onText?.(part.text);
          }
          if (part.functionCall) {
            toolCalls.push({
              id: part.functionCall.id || `call_${Date.now()}_${toolCalls.length}`,
              name: part.functionCall.name,
              input: part.functionCall.args || {},
            });
          }
        }

        if (candidate.finishReason === "MAX_TOKENS") {
          stopReason = "max_tokens";
        }

        // Usage metadata
        if (chunk.usageMetadata) {
          usage.input_tokens = chunk.usageMetadata.promptTokenCount || 0;
          usage.output_tokens = chunk.usageMetadata.candidatesTokenCount || 0;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Build content in Anthropic format
  if (currentText) {
    content.push({ type: "text", text: currentText });
  }
  for (const tc of toolCalls) {
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  // If there are tool calls, stop reason is tool_use
  if (toolCalls.length > 0) {
    stopReason = "tool_use";
  }

  return { content, stop_reason: stopReason, usage };
}

// --- Main Call ---

/**
 * Call Vertex AI Gemini. Returns Anthropic-format LLMResponse.
 *
 * Drop-in replacement for the Anthropic callLLM — same params, same response format.
 */
const MAX_RETRIES = 5;

export async function callVertexLLM(params: CallLLMParams): Promise<LLMResponse> {
  if (!vertexConfig) {
    throw new Error("Vertex AI not initialized. Call initVertex() first.");
  }

  const {
    messages,
    system,
    tools,
    model = "gemini-2.5-flash",
    maxTokens = 16384,
    signal,
    onText,
  } = params;

  const { projectId } = vertexConfig;

  // Use global endpoint — Google routes to whichever region has capacity,
  // reducing 429s compared to pinning to a single region.
  const url = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${model}:streamGenerateContent?alt=sse`;

  const systemText = system.map((s) => s.text).join("\n\n");

  const body = JSON.stringify({
    contents: convertMessages(messages),
    tools: convertTools(tools),
    tool_config: {
      function_calling_config: { mode: "AUTO" },
    },
    generationConfig: {
      maxOutputTokens: maxTokens,
    },
    systemInstruction: { parts: [{ text: systemText }] },
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    const token = await getAccessToken();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
      signal,
    });

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = response.headers.get("retry-after");
      const delay = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
      console.error(
        `[Vertex] 429 rate limited, retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms`
      );
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Vertex AI error ${response.status}: ${errorText.slice(0, 300)}`
      );
    }

    const result = await parseGeminiStream(response, onText, signal);
    result.model = model;
    return result;
  }

  throw new Error("Vertex AI: max retries exceeded (429 rate limit)");
}
