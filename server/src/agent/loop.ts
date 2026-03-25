/**
 * Server-Side Managed Agent Loop
 *
 * Drives the browser automation agent from the server:
 * 1. Receives a task
 * 2. Calls Vertex AI (via callLLM) with system prompt + tools
 * 3. For each tool_use: sends execution request to extension via WebSocket relay
 * 4. Gets tool results back from extension
 * 5. Feeds results back to Vertex AI
 * 6. Repeats until end_turn or max steps
 * 7. Returns the final answer
 *
 * The extension is a dumb tool executor — it only runs tools and returns results.
 * All intelligence lives here.
 */

import { callLLM } from "../llm/client.js";
import type {
  Message,
  ContentBlock,
  ContentBlockText,
  ContentBlockToolUse,
  LLMResponse,
} from "../llm/client.js";
import { AGENT_TOOLS } from "./tools.js";
import { buildSystemPrompt } from "./system-prompt.js";

// --- Types ---

export interface AgentLoopParams {
  /** The task description */
  task: string;
  /** Optional starting URL */
  url?: string;
  /** Optional context (form data, preferences, etc.) */
  context?: string;
  /** Function to execute a tool on the extension. Returns the tool result. */
  executeTool: (
    toolName: string,
    toolInput: Record<string, any>
  ) => Promise<ToolResult>;
  /** Optional callback for step updates */
  onStep?: (step: StepUpdate) => void;
  /** Optional callback for streaming text */
  onText?: (chunk: string) => void;
  /** Max agent loop iterations (default: 50) */
  maxSteps?: number;
  /** Abort signal */
  signal?: AbortSignal;
}

export interface ToolResult {
  success: boolean;
  output?: any;
  error?: string;
  /** Base64 screenshot if the tool returned one */
  screenshot?: { data: string; mediaType: string };
}

export interface StepUpdate {
  step: number;
  status: "thinking" | "tool_use" | "tool_result" | "complete" | "error";
  toolName?: string;
  toolInput?: Record<string, any>;
  text?: string;
}

export interface AgentLoopResult {
  status: "complete" | "error" | "max_steps";
  answer: string;
  steps: number;
  usage: { inputTokens: number; outputTokens: number; apiCalls: number };
  /** The model used for the last LLM call (for billing attribution) */
  model?: string;
}

// --- Agent Loop ---

export async function runAgentLoop(
  params: AgentLoopParams
): Promise<AgentLoopResult> {
  const {
    task,
    url,
    context,
    executeTool,
    onStep,
    onText,
    maxSteps = 50,
    signal,
  } = params;

  const system = buildSystemPrompt();
  const tools = AGENT_TOOLS;
  const messages: Message[] = [];
  let totalUsage = { inputTokens: 0, outputTokens: 0, apiCalls: 0 };
  let lastModel: string | undefined;

  // Build initial user message
  let userMessage = task;
  if (url) {
    userMessage = `Navigate to ${url} first, then: ${task}`;
  }
  if (context) {
    userMessage += `\n\n<context>\n${context}\n</context>`;
  }
  messages.push({ role: "user", content: userMessage });

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) {
      return {
        status: "error",
        answer: "Task was cancelled.",
        steps: step - 1,
        usage: totalUsage,
        model: lastModel,
      };
    }

    onStep?.({ step, status: "thinking" });

    // Call LLM
    let response: LLMResponse;
    try {
      response = await callLLM({
        messages,
        system,
        tools,
        signal,
        onText,
      });
    } catch (err: any) {
      console.error(`[AgentLoop] LLM call failed at step ${step}:`, err.message);
      return {
        status: "error",
        answer: `LLM call failed: ${err.message}`,
        steps: step,
        usage: totalUsage,
        model: lastModel,
      };
    }

    totalUsage.apiCalls++;
    totalUsage.inputTokens += response.usage?.input_tokens || 0;
    totalUsage.outputTokens += response.usage?.output_tokens || 0;
    if (response.model) lastModel = response.model;

    // Add assistant response to conversation
    messages.push({ role: "assistant", content: response.content });

    // Extract text and tool calls
    const textBlocks = response.content.filter(
      (b): b is ContentBlockText => b.type === "text"
    );
    const toolUseBlocks = response.content.filter(
      (b): b is ContentBlockToolUse => b.type === "tool_use"
    );

    // If no tool calls, we're done
    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      const answer = textBlocks.map((b) => b.text).join("\n").trim();
      onStep?.({ step, status: "complete", text: answer });
      return {
        status: "complete",
        answer: answer || "Task completed.",
        steps: step,
        usage: totalUsage,
        model: lastModel,
      };
    }

    // Execute each tool call
    const allowedToolNames = new Set(tools.map((t) => t.name));
    const toolResults: ContentBlock[] = [];
    for (const toolUse of toolUseBlocks) {
      // Validate tool name against allowed list before forwarding to extension
      if (!allowedToolNames.has(toolUse.name)) {
        console.error(`[AgentLoop] LLM requested unknown tool: ${toolUse.name}`);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: [{ type: "text", text: `Error: Unknown tool "${toolUse.name}". Available tools: ${[...allowedToolNames].join(", ")}` }],
        } as any);
        continue;
      }

      onStep?.({
        step,
        status: "tool_use",
        toolName: toolUse.name,
        toolInput: toolUse.input,
      });

      let result: ToolResult;
      try {
        result = await executeTool(toolUse.name, toolUse.input);
      } catch (err: any) {
        // Retry once on transient errors (timeouts, relay disconnects)
        const isTransient =
          err.message?.includes("timed out") ||
          err.message?.includes("not connected") ||
          err.message?.includes("Relay");
        if (isTransient && !signal?.aborted) {
          console.error(`[AgentLoop] Transient error on ${toolUse.name}, retrying once: ${err.message}`);
          try {
            result = await executeTool(toolUse.name, toolUse.input);
          } catch (retryErr: any) {
            result = { success: false, error: `${retryErr.message} (after retry)` };
          }
        } else {
          result = { success: false, error: err.message };
        }
      }

      onStep?.({ step, status: "tool_result", toolName: toolUse.name });

      // Check abort after each tool — don't feed results back to LLM if cancelled
      if (signal?.aborted) {
        return {
          status: "error",
          answer: "Task was cancelled.",
          steps: step,
          usage: totalUsage,
          model: lastModel,
        };
      }

      // Build tool result content block
      const resultContent: Array<ContentBlockText | { type: "image"; source: any }> = [];

      // Add text result
      const textOutput = result.error
        ? `Error: ${result.error}`
        : typeof result.output === "string"
        ? result.output
        : JSON.stringify(result.output);
      resultContent.push({ type: "text", text: textOutput });

      // Add screenshot if present
      if (result.screenshot) {
        resultContent.push({
          type: "image",
          source: {
            type: "base64",
            media_type: result.screenshot.mediaType,
            data: result.screenshot.data,
          },
        });
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: resultContent,
      } as any);
    }

    // Add tool results as user message
    messages.push({ role: "user", content: toolResults });
  }

  // Exceeded max steps
  const lastText = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text)
        : [m.content]
    )
    .pop();

  return {
    status: "max_steps",
    answer: lastText || "Task did not complete within the step limit.",
    steps: maxSteps,
    usage: totalUsage,
    model: lastModel,
  };
}
