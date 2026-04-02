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
import { AGENT_TOOLS } from "./tools.js";
import { buildSystemPrompt } from "./system-prompt.js";
// --- Agent Loop ---
export async function runAgentLoop(params) {
    const { task, url, context, executeTool, onStep, onText, maxSteps = 50, signal, } = params;
    // Detect target URL for domain knowledge — from explicit url param or from task text
    const targetUrl = url || task.match(/https?:\/\/[^\s"')]+/)?.[0];
    const system = buildSystemPrompt(targetUrl);
    const tools = AGENT_TOOLS;
    const messages = [];
    const turns = [];
    let totalUsage = { inputTokens: 0, outputTokens: 0, apiCalls: 0 };
    let lastModel;
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
        let response;
        try {
            response = await callLLM({
                messages,
                system,
                tools,
                signal,
                onText,
            });
        }
        catch (err) {
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
        if (response.model)
            lastModel = response.model;
        // Add assistant response to conversation (preserve raw Gemini parts for thought signatures)
        const assistantMsg = { role: "assistant", content: response.content };
        if (response._rawGeminiParts) {
            assistantMsg._rawGeminiParts = response._rawGeminiParts;
        }
        messages.push(assistantMsg);
        // Extract text and tool calls
        const textBlocks = response.content.filter((b) => b.type === "text");
        const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
        // Start building the turn log for this step
        const currentTurn = {
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
        const toolResults = [];
        for (const toolUse of toolUseBlocks) {
            // Validate tool name against allowed list before forwarding to extension
            if (!allowedToolNames.has(toolUse.name)) {
                console.error(`[AgentLoop] LLM requested unknown tool: ${toolUse.name}`);
                toolResults.push({
                    type: "tool_result",
                    tool_use_id: toolUse.id,
                    content: [{ type: "text", text: `Error: Unknown tool "${toolUse.name}". Available tools: ${[...allowedToolNames].join(", ")}` }],
                });
                continue;
            }
            // Log tool call
            const inputSummary = toolUse.name === "navigate" ? toolUse.input.url
                : toolUse.name === "computer" ? `${toolUse.input.action}${toolUse.input.ref ? ` ref=${toolUse.input.ref}` : ""}${toolUse.input.coordinate ? ` @${toolUse.input.coordinate}` : ""}`
                    : toolUse.name === "javascript_tool" ? toolUse.input.text?.slice(0, 80)
                        : JSON.stringify(toolUse.input).slice(0, 80);
            console.error(`[AgentLoop] Step ${step}: ${toolUse.name}(${inputSummary})`);
            onStep?.({
                step,
                status: "tool_use",
                toolName: toolUse.name,
                toolInput: toolUse.input,
            });
            let result;
            const toolStartMs = Date.now();
            try {
                result = await executeTool(toolUse.name, toolUse.input);
            }
            catch (err) {
                // Retry once on transient errors (timeouts, relay disconnects)
                const isTransient = err.message?.includes("timed out") ||
                    err.message?.includes("not connected") ||
                    err.message?.includes("Relay");
                if (isTransient && !signal?.aborted) {
                    console.error(`[AgentLoop] Transient error on ${toolUse.name}, retrying once: ${err.message}`);
                    try {
                        result = await executeTool(toolUse.name, toolUse.input);
                    }
                    catch (retryErr) {
                        result = { success: false, error: `${retryErr.message} (after retry)` };
                    }
                }
                else {
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
            const resultContent = [];
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
            });
        }
        // Add tool results as user message
        messages.push({ role: "user", content: toolResults });
        turns.push(currentTurn);
    }
    // Exceeded max steps
    const lastText = messages
        .filter((m) => m.role === "assistant")
        .flatMap((m) => Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "text").map((b) => b.text)
        : [m.content])
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
