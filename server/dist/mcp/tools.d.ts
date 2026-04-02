/**
 * MCP tool definitions and prompt templates.
 *
 * Pure data — no runtime dependencies. Loaded by the MCP server (index.ts).
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
export declare const TOOLS: Tool[];
export declare const PROMPTS: {
    name: string;
    description: string;
    arguments: {
        name: string;
        description: string;
        required: boolean;
    }[];
}[];
export declare const PROMPT_TEMPLATES: Record<string, (args: Record<string, string>) => {
    description: string;
    messages: any[];
}>;
