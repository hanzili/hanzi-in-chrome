import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAgentLoop } from "./loop.js";

// Mock callLLM so the test doesn't need an LLM or relay. It always tells the
// agent to navigate to the same dead URL — simulating the x.com trap seen in
// the wild (see docs/superpowers/plans/2026-04-16-domain-skills-eval-implementation.md).
const deadUrl = "https://x.com/sama/status/1871729391595520213";

vi.mock("../llm/client.js", () => ({
  callLLM: vi.fn(async () => ({
    content: [
      {
        type: "tool_use",
        id: `t-${Math.random().toString(36).slice(2, 8)}`,
        name: "navigate",
        input: { url: deadUrl },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  })),
}));

describe("runAgentLoop stuck-loop detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aborts early when the agent navigates to the same URL 3+ times", async () => {
    const executeTool = vi.fn(async () => ({
      success: true,
      output: "Navigated (fake)",
    }));

    const result = await runAgentLoop({
      task: "test dead-url loop",
      url: deadUrl,
      executeTool,
      maxSteps: 50,
    });

    expect(result.status).toBe("error");
    expect(result.answer).toMatch(/Stuck-loop/);
    expect(result.answer).toContain(deadUrl);
    // Must abort well before maxSteps — the whole point.
    expect(result.steps).toBeLessThanOrEqual(5);
    // The 3rd navigate triggers the abort BEFORE executing, so the tool runs
    // exactly twice (for navigates 1 and 2) and never for the 3rd repeat.
    expect(executeTool.mock.calls.length).toBe(2);
  });
});
