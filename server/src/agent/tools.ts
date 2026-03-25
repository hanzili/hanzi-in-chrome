/**
 * Tool definitions for server-side managed agent loop.
 *
 * These mirror the extension's tool definitions but are used by the server
 * when driving the agent loop via Vertex AI. The extension receives
 * tool execution requests and returns results.
 */

import type { Tool } from "../llm/client.js";

export const AGENT_TOOLS: Tool[] = [
  {
    name: "read_page",
    description: `Get a rich DOM tree of the page via Chrome DevTools Protocol. Returns interactive elements with numeric backendNodeId references (e.g., [42]<button>Submit</button>). IMPORTANT: Only use element IDs from the CURRENT output — IDs change between calls. Pierces shadow DOM and iframes automatically.`,
    input_schema: {
      type: "object",
      properties: {
        max_chars: {
          type: "number",
          description: "Maximum characters for output (default: 50000).",
        },
      },
      required: [],
    },
  },
  {
    name: "find",
    description: `Find elements on the page using natural language. Can search by purpose (e.g., "search bar", "login button") or text content. Returns up to 20 matching elements with references.`,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'Natural language description of what to find (e.g., "search bar", "add to cart button")',
        },
      },
      required: ["query"],
    },
  },
  {
    name: "form_input",
    description: `Set values in ANY form element — text inputs, textareas, dropdowns, checkboxes, radio buttons, date pickers. For dropdowns, just pass the desired option text. ALWAYS prefer form_input over computer clicks for form fields.`,
    input_schema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: 'Element reference from read_page (e.g., "42") or find tool (e.g., "ref_1")',
        },
        value: {
          type: "string",
          description: "The value to set.",
        },
      },
      required: ["ref", "value"],
    },
  },
  {
    name: "computer",
    description: `Use a mouse and keyboard to interact with a web browser, and take screenshots.
* Click elements using their ref from read_page or find tools.
* Take screenshots to see the current page state.
* Scroll to see more content.`,
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "left_click", "right_click", "type", "screenshot", "wait",
            "scroll", "key", "left_click_drag", "double_click", "triple_click",
            "zoom", "scroll_to", "hover",
          ],
          description: "The action to perform.",
        },
        coordinate: {
          type: "array",
          items: { type: "number" },
          description: "(x, y) pixel coordinates for click/scroll actions.",
        },
        text: {
          type: "string",
          description: "Text to type or key(s) to press.",
        },
        duration: {
          type: "number",
          description: "Seconds to wait (for wait action). Max 30.",
        },
        scroll_direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Direction to scroll.",
        },
        scroll_amount: {
          type: "number",
          description: "Number of scroll ticks (1-10).",
        },
        ref: {
          type: "string",
          description: "Element reference for click/scroll_to actions.",
        },
        region: {
          type: "array",
          items: { type: "number" },
          description: "(x0, y0, x1, y1) region for zoom action.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "navigate",
    description: `Navigate to a URL, or go forward/back in browser history.`,
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: 'The URL to navigate to. Use "forward"/"back" for history navigation.',
        },
      },
      required: ["url"],
    },
  },
  {
    name: "get_page_text",
    description: `Extract raw text content from the page, prioritizing article content. Ideal for reading text-heavy pages.`,
    input_schema: {
      type: "object",
      properties: {
        max_chars: {
          type: "number",
          description: "Maximum characters for output (default: 50000).",
        },
      },
      required: [],
    },
  },
  {
    name: "javascript_tool",
    description: `Execute JavaScript in the page context. Returns the result of the last expression. Do NOT use 'return' — just write the expression.`,
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Must be 'javascript_exec'.",
        },
        text: {
          type: "string",
          description: "JavaScript code to execute.",
        },
      },
      required: ["action", "text"],
    },
  },
];
