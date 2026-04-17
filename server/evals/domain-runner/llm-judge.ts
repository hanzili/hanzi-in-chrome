import { callLLM } from "../../src/llm/client.js";

export interface JudgeParams {
  screenshot: { data: string; mediaType: string };
  prompt: string;
  model?: string;
}

export interface JudgeResult {
  pass: boolean;
  rawAnswer: string;
}

const SYSTEM = `You are a strict test judge. Answer the user's question about the attached screenshot with exactly one word: "yes" or "no". Do not add any other text.`;

export async function judgeScreenshot(p: JudgeParams): Promise<JudgeResult> {
  const resp = await callLLM({
    system: [{ type: "text", text: SYSTEM }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: p.prompt },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: p.screenshot.mediaType,
              data: p.screenshot.data,
            },
          } as any,
        ],
      },
    ],
    tools: [],
    model: p.model,
    maxTokens: 10,
  });
  const text =
    (resp.content.find(b => b.type === "text") as any)?.text?.toLowerCase().trim() ?? "";
  const pass = text.startsWith("yes");
  return { pass, rawAnswer: text };
}
