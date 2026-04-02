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
export interface AgentLoopParams {
    /** The task description */
    task: string;
    /** Optional starting URL */
    url?: string;
    /** Optional context (form data, preferences, etc.) */
    context?: string;
    /** Function to execute a tool on the extension. Returns the tool result. */
    executeTool: (toolName: string, toolInput: Record<string, any>) => Promise<ToolResult>;
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
    screenshot?: {
        data: string;
        mediaType: string;
    };
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
    usage: {
        inputTokens: number;
        outputTokens: number;
        apiCalls: number;
    };
    /** The model used for the last LLM call (for billing attribution) */
    model?: string;
    /** Structured turn-by-turn log of the agent's actions */
    turns?: TurnLog[];
}
export declare function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult>;
