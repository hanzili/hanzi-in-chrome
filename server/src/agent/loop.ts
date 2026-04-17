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

export interface TurnLog {
  step: number;
  tools: Array<{
    name: string;
    input: Record<string, any>;
    result: string;
    durationMs: number;
  }>;
  ai_response: string | null;
}

export interface AgentLoopResult {
  status: "complete" | "error" | "max_steps";
  answer: string;
  steps: number;
  usage: { inputTokens: number; outputTokens: number; apiCalls: number };
  /** The model used for the last LLM call (for billing attribution) */
  model?: string;
  /** Structured turn-by-turn log of the agent's actions */
  turns?: TurnLog[];
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

  // Detect target URL for domain knowledge — from explicit url param or from task text
  const targetUrl = url || task.match(/https?:\/\/[^\s"')]+/)?.[0];
  const system = buildSystemPrompt(targetUrl);
  const tools = AGENT_TOOLS;
  const messages: Message[] = [];
  const turns: TurnLog[] = [];
  let totalUsage = { inputTokens: 0, outputTokens: 0, apiCalls: 0 };
  let lastModel: string | undefined;

  // Stuck-loop detection: if the agent navigates to the same URL 3+ times in a
  // rolling window of 5, something is wrong (dead link, anti-bot redirect, etc).
  // Abort early so a bad page doesn't burn 50 steps and ~1.8M tokens.
  const recentNavigates: string[] = [];
  const NAV_WINDOW = 5;
  const NAV_REPEAT_THRESHOLD = 3;

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
        turns,
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
        turns,
      };
    }

    totalUsage.apiCalls++;
    totalUsage.inputTokens += response.usage?.input_tokens || 0;
    totalUsage.outputTokens += response.usage?.output_tokens || 0;
    if (response.model) lastModel = response.model;

    // Add assistant response to conversation (preserve raw Gemini parts for thought signatures)
    const assistantMsg: any = { role: "assistant", content: response.content };
    if ((response as any)._rawGeminiParts) {
      assistantMsg._rawGeminiParts = (response as any)._rawGeminiParts;
    }
    messages.push(assistantMsg);

    // Extract text and tool calls
    const textBlocks = response.content.filter(
      (b): b is ContentBlockText => b.type === "text"
    );
    const toolUseBlocks = response.content.filter(
      (b): b is ContentBlockToolUse => b.type === "tool_use"
    );

    // Start building the turn log for this step
    const currentTurn: TurnLog = {
      step,
      tools: [],
      ai_response: textBlocks.map((b) => b.text).join("\n").trim() || null,
    };

    // If no tool calls, we're done
    if (response.stop_reason === "end_turn" || toolUseBlocks.length === 0) {
      const answer = textBlocks.map((b) => b.text).join("\n").trim();
      turns.push(currentTurn);
      console.error(`[AgentLoop] Complete at step ${step} (${totalUsage.apiCalls} API calls, ${totalUsage.inputTokens} input tokens)`);
      onStep?.({ step, status: "complete", text: answer });
      return {
        status: "complete",
        answer: answer || "Task completed.",
        steps: step,
        usage: totalUsage,
        model: lastModel,
        turns,
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

      // Log tool call
      const inputSummary = toolUse.name === "navigate" ? toolUse.input.url
        : toolUse.name === "computer" ? `${toolUse.input.action}${toolUse.input.ref ? ` ref=${toolUse.input.ref}` : ""}${toolUse.input.coordinate ? ` @${toolUse.input.coordinate}` : ""}`
        : toolUse.name === "javascript_tool" ? toolUse.input.text?.slice(0, 80)
        : JSON.stringify(toolUse.input).slice(0, 80);
      console.error(`[AgentLoop] Step ${step}: ${toolUse.name}(${inputSummary})`);

      // Stuck-loop check: same URL navigated to ≥3 times in the last 5 navigates.
      if (toolUse.name === "navigate" && typeof toolUse.input?.url === "string") {
        const u = toolUse.input.url as string;
        recentNavigates.push(u);
        if (recentNavigates.length > NAV_WINDOW) recentNavigates.shift();
        const hits = recentNavigates.filter((x) => x === u).length;
        if (hits >= NAV_REPEAT_THRESHOLD) {
          console.error(`[AgentLoop] Stuck: navigated to ${u} ${hits}x in last ${recentNavigates.length} navigates — aborting`);
          turns.push(currentTurn);
          return {
            status: "error",
            answer: `Stuck-loop detected: agent navigated to "${u}" ${hits} times in the last ${recentNavigates.length} navigates without progress. The URL likely doesn't exist, is blocked, or the agent is confused. Task aborted early to save tokens.`,
            steps: step,
            usage: totalUsage,
            model: lastModel,
            turns,
          };
        }
      }

      onStep?.({
        step,
        status: "tool_use",
        toolName: toolUse.name,
        toolInput: toolUse.input,
      });

      let result: ToolResult;
      const toolStartMs = Date.now();
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

      // Log result summary
      const toolDurationMs = Date.now() - toolStartMs;
      const resultText = result.error ? `Error: ${result.error}`
        : typeof result.output === "string" ? result.output
        : JSON.stringify(result.output);
      const resultSummary = resultText.length > 120 ? resultText.slice(0, 120) + "..." : resultText;
      console.error(`[AgentLoop] Step ${step}: ${toolUse.name} → ${resultSummary}`);

      // Add to structured turn log (truncate large results to keep log manageable)
      currentTurn.tools.push({
        name: toolUse.name,
        input: toolUse.input,
        result: (resultText.length > 5000 ? resultText.slice(0, 5000) + "... [truncated]" : resultText)
          + (result.screenshot ? " [+screenshot]" : ""),
        durationMs: toolDurationMs,
      });

      onStep?.({ step, status: "tool_result", toolName: toolUse.name });

      // Check abort after each tool — don't feed results back to LLM if cancelled
      if (signal?.aborted) {
        turns.push(currentTurn);
        return {
          status: "error",
          answer: "Task was cancelled.",
          steps: step,
          usage: totalUsage,
          model: lastModel,
          turns,
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
    turns.push(currentTurn);
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
    turns,
  };
}
