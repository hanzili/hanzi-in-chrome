import { describe, it, expect, vi } from "vitest";
import { judgeScreenshot } from "./llm-judge.js";

// Mock callLLM to avoid real API calls in unit tests.
vi.mock("../../src/llm/client.js", () => ({
  callLLM: vi.fn(async (params: any) => {
    const prompt = params.messages[0].content[0].text ?? "";
    // Return "yes" if the judge prompt mentions "reply", else "no".
    const text = prompt.includes("reply") ? "yes" : "no";
    return {
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }),
}));

describe("judgeScreenshot", () => {
  it("returns true when the LLM says yes", async () => {
    const result = await judgeScreenshot({
      screenshot: { data: "aGVsbG8=", mediaType: "image/png" },
      prompt: "Is there a reply below the tweet?",
    });
    expect(result.pass).toBe(true);
  });

  it("returns false when the LLM says no", async () => {
    const result = await judgeScreenshot({
      screenshot: { data: "aGVsbG8=", mediaType: "image/png" },
      prompt: "Is there a unicorn on the page?",
    });
    expect(result.pass).toBe(false);
  });
});
