/**
 * Tool Definitions for Browser Automation
 */

/**
 * Tools that only work with Claude models.
 * These should be filtered out for other providers (OpenAI, Codex, etc.)
 * - turn_answer_start: Claude signals before responding
 * - update_plan: Claude's "ask before acting" planning tool
 */
export const CLAUDE_ONLY_TOOLS = ['turn_answer_start', 'update_plan'];

export const TOOL_DEFINITIONS = [
  {
    name: 'read_page',
    description: `Get a rich DOM tree of the page via Chrome DevTools Protocol. Returns interactive elements with numeric backendNodeId references (e.g., [42]<button>Submit</button>). IMPORTANT: Only use element IDs from the CURRENT output — IDs change between calls. Pierces shadow DOM and iframes automatically. tabId is optional — if omitted, the active tab is used automatically.`,
    input_schema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab ID to target. Optional — if omitted, uses the active tab in your window.',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs.',
        },
      },
      required: [],
    },
  },

  {
    name: 'find',
    description: `Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). Returns up to 20 matching elements with references that can be used with other tools. If more than 20 matches exist, you'll be notified to use a more specific query. tabId is optional — if omitted, the active tab in your window is used automatically.`,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to search in. Optional — if omitted, uses the active tab in your window.',
        },
      },
      required: ['query'],
    },
  },

  {
    name: 'form_input',
    description: `Set values in ANY form element — text inputs, textareas, native <select> dropdowns, custom React/Workday/MUI dropdown comboboxes, checkboxes, radio buttons, date pickers, and number inputs. For dropdowns (both native and custom), just pass the desired option text as the value — the tool automatically opens the dropdown, searches, and selects the match. This is the FASTEST way to fill any form field (1 tool call vs 5-10 with computer clicks). ALWAYS prefer form_input over computer clicks for form fields. tabId is optional — if omitted, the active tab in your window is used automatically.`,
    input_schema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Element reference from read_page (numeric backendNodeId, e.g., "42") or find tool (e.g., "ref_1")',
        },
        value: {
          type: ['string', 'boolean', 'number'],
          description: 'The value to set. For checkboxes use boolean, for selects/dropdowns use option text, for other inputs use appropriate string/number',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to set form value in. Optional — if omitted, uses the active tab in your window.',
        },
      },
      required: ['ref', 'value'],
    },
  },

  {
    name: 'computer',
    description: `Use a mouse and keyboard to interact with a web browser, and take screenshots. tabId is optional — if omitted, the active tab in your window is used automatically.
* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.
* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.
* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'left_click',
            'right_click',
            'type',
            'screenshot',
            'wait',
            'scroll',
            'key',
            'left_click_drag',
            'double_click',
            'triple_click',
            'zoom',
            'scroll_to',
            'hover',
          ],
          description: `The action to perform:
* \`left_click\`: Click the left mouse button at the specified coordinates.
* \`right_click\`: Click the right mouse button at the specified coordinates to open context menus.
* \`double_click\`: Double-click the left mouse button at the specified coordinates.
* \`triple_click\`: Triple-click the left mouse button at the specified coordinates.
* \`type\`: Type a string of text.
* \`screenshot\`: Take a screenshot of the screen.
* \`wait\`: Wait for a specified number of seconds.
* \`scroll\`: Scroll up, down, left, or right at the specified coordinates.
* \`key\`: Press a specific keyboard key.
* \`left_click_drag\`: Drag from start_coordinate to coordinate.
* \`zoom\`: Take a screenshot of a specific region for closer inspection.
* \`scroll_to\`: Scroll an element into view using its element reference ID from read_page or find tools.
* \`hover\`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states.`,
        },
        coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: '(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position.',
        },
        text: {
          type: 'string',
          description: 'The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform\'s modifier key (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a" or "ctrl+a" for select all).',
        },
        duration: {
          type: 'number',
          minimum: 0,
          maximum: 30,
          description: 'The number of seconds to wait. Required for `wait`. Maximum 30 seconds.',
        },
        scroll_direction: {
          type: 'string',
          enum: ['up', 'down', 'left', 'right'],
          description: 'The direction to scroll. Required for `scroll`.',
        },
        scroll_amount: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          description: 'The number of scroll wheel ticks. Optional for `scroll`, defaults to 3.',
        },
        start_coordinate: {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
          description: '(x, y): The starting coordinates for `left_click_drag`.',
        },
        region: {
          type: 'array',
          items: { type: 'number' },
          minItems: 4,
          maxItems: 4,
          description: '(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for inspecting small UI elements like icons, buttons, or text.',
        },
        repeat: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times.',
        },
        ref: {
          type: 'string',
          description: 'Element reference from read_page (numeric backendNodeId, e.g., "42") or find tool (e.g., "ref_1"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions.',
        },
        modifiers: {
          type: 'string',
          description: 'Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). Optional.',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to execute the action on. Optional — if omitted, uses the active tab in your window.',
        },
      },
      required: ['action'],
    },
  },

  {
    name: 'navigate',
    description: `Navigate to a URL, or go forward/back in browser history. tabId is optional — if omitted, the active tab in your window is used automatically.`,
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to navigate. Optional — if omitted, uses the active tab in your window.',
        },
      },
      required: ['url'],
    },
  },

  {
    name: 'get_page_text',
    description: `Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. tabId is optional — if omitted, the active tab in your window is used automatically. Output is limited to 50000 characters by default. If the output exceeds this limit, you will receive an error suggesting alternatives.`,
    input_schema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab ID to extract text from. Optional — if omitted, uses the active tab in your window.',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs.',
        },
      },
      required: [],
    },
  },

  {
    type: 'custom',
    name: 'update_plan',
    description: 'Update the plan and present it to the user for approval before proceeding.',
    input_schema: {
      type: 'object',
      properties: {
        domains: {
          type: 'array',
          items: { type: 'string' },
          description: "List of domains you will visit (e.g., ['github.com', 'stackoverflow.com']). These domains will be approved for the session when the user accepts the plan.",
        },
        approach: {
          type: 'array',
          items: { type: 'string' },
          description: "Ordered list of steps you will follow (e.g., ['Navigate to homepage', 'Search for documentation', 'Extract key information']). Be concise - aim for 3-7 steps.",
        },
      },
      required: ['domains', 'approach'],
    },
  },

  {
    name: 'tabs_create',
    description: 'Creates a new empty tab in the current tab group',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  {
    name: 'tabs_context',
    description: 'Get context information about all tabs in the current tab group',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  {
    name: 'tabs_close',
    description: 'Close a tab or popup window. Use this to close popup windows after completing actions in them, or to clean up tabs that are no longer needed. You MUST specify the tabId — use tabs_context to find it.',
    input_schema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab ID to close. Required. Use tabs_context to see available tabs.',
        },
      },
      required: ['tabId'],
    },
  },

  {
    name: 'read_console_messages',
    description: `Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. Useful for debugging JavaScript errors, viewing application logs, or understanding what's happening in the browser console. Returns console messages from the current domain only. tabId is optional — if omitted, the active tab in your window is used automatically. IMPORTANT: Always provide a pattern to filter messages - without a pattern, you may get too many irrelevant messages.`,
    input_schema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab ID to read console messages from. Optional — if omitted, uses the active tab in your window.',
        },
        onlyErrors: {
          type: 'boolean',
          description: 'If true, only return error and exception messages. Default is false (return all message types).',
        },
        clear: {
          type: 'boolean',
          description: 'If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false.',
        },
        pattern: {
          type: 'string',
          description: "Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., 'error|warning' to find errors and warnings, 'MyApp' to filter app-specific logs). You should always provide a pattern to avoid getting too many irrelevant messages.",
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return. Defaults to 100. Increase only if you need more results.',
        },
      },
      required: [],
    },
  },

  {
    name: 'read_network_requests',
    description: `Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests made by the current page, including cross-origin requests. Requests are automatically cleared when the page navigates to a different domain. tabId is optional — if omitted, the active tab in your window is used automatically.`,
    input_schema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab ID to read network requests from. Optional — if omitted, uses the active tab in your window.',
        },
        urlPattern: {
          type: 'string',
          description: "Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., '/api/' to filter API calls, 'example.com' to filter by domain).",
        },
        clear: {
          type: 'boolean',
          description: 'If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of requests to return. Defaults to 100. Increase only if you need more results.',
        },
      },
      required: [],
    },
  },

  {
    name: 'solve_captcha',
    description: `Solve a CAPTCHA on deckathon-concordia.com. This tool automatically uses the captured challenge data and brute-forces the solution. Returns the indices of images to click (0-indexed). After getting the indices, click those images and then click Verify.`,
    input_schema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: 'Tab ID where the CAPTCHA is displayed. Optional — if omitted, uses the active tab in your window.',
        },
      },
      required: [],
    },
    // Domain-specific tool: only show on matching domains
    _domains: ['deckathon-concordia.com'],
  },

  {
    name: 'resize_window',
    description: `Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up specific screen sizes. tabId is optional — if omitted, the active tab in your window is used automatically.`,
    input_schema: {
      type: 'object',
      properties: {
        width: {
          type: 'number',
          description: 'Target window width in pixels',
        },
        height: {
          type: 'number',
          description: 'Target window height in pixels',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to get the window for. Optional — if omitted, uses the active tab in your window.',
        },
      },
      required: ['width', 'height'],
    },
  },

  {
    type: 'custom',
    name: 'turn_answer_start',
    description: 'Call this immediately before your text response to the user for this turn. Required every turn - whether or not you made tool calls. After calling, write your response. No more tools after this.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  {
    name: 'javascript_tool',
    description: `Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. tabId is optional — if omitted, the active tab in your window is used automatically.`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: "Must be set to 'javascript_exec'",
        },
        text: {
          type: 'string',
          description: "The JavaScript code to execute. The code will be evaluated in the page context. The result of the last expression will be returned automatically. Do NOT use 'return' statements - just write the expression you want to evaluate (e.g., 'window.myData.value' not 'return window.myData.value'). You can access and modify the DOM, call page functions, and interact with page variables.",
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to execute the code in. Optional — if omitted, uses the active tab in your window.',
        },
      },
      required: ['action', 'text'],
    },
  },

  {
    name: 'view_screenshot',
    description: `View a previously captured screenshot. Use this when you need to re-examine a screenshot you took earlier (e.g., after many steps, to recall what you saw). Returns the image so you can see it. Does NOT upload anything to a webpage — use file_upload for that.`,
    input_schema: {
      type: 'object',
      properties: {
        imageId: {
          type: 'string',
          description: 'ID of a previously captured screenshot (e.g., "screenshot_1"). Get this from the computer tool\'s screenshot action.',
        },
      },
      required: ['imageId'],
    },
  },

  {
    name: 'file_upload',
    description: `Upload a file to a file input element on the page. You can provide just the filename (e.g., "report.pdf") and it will be resolved from the downloads folder, or provide a full absolute path. Provide either a ref or CSS selector to identify the file input. Works with hidden file inputs and custom upload buttons.`,
    input_schema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Element reference from read_page (numeric backendNodeId, e.g., "42") or find tool (e.g., "ref_1")',
        },
        selector: {
          type: 'string',
          description: 'CSS selector for the file input (e.g., "input[type=file]", "#resume-upload"). Used if ref not provided.',
        },
        filePath: {
          type: 'string',
          description: 'Filename (e.g., "resume.pdf") resolved from downloads folder, or absolute path (e.g., "/Users/name/Documents/resume.pdf"). Prefer just the filename.',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID where the file input is located. Optional — if omitted, uses the active tab in your window.',
        },
      },
      required: ['filePath'],
    },
    cache_control: {
      type: 'ephemeral',
    },
  },

  {
    name: 'get_info',
    description: `Search task memory for specific information needed to fill forms.

BEFORE using this tool: Check the <system-reminder> tags in the conversation first!
Task context is often already provided there. Only use get_info if the info isn't in the reminders.

The query should describe what information you need in natural language.

Examples:
- "product description"
- "pricing information"
- "company website URL"
- "logo file path"

If get_info returns "not found":
1. Check <system-reminder> tags again (you might have missed it)
2. If truly missing, ASK THE USER: "I need [field] but don't have it. What should I put?"
3. Do NOT call get_info repeatedly for the same missing info`,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of the information you need (e.g., "product description", "pricing", "company website URL")',
        },
      },
      required: ['query'],
    },
  },

  {
    name: 'escalate',
    description: `Report a blocker to get guidance from the planning system.

Use this ONLY when you are genuinely STUCK and cannot proceed:
- A required field needs information you don't have (file paths, credentials, specific data)
- An element keeps failing after 2-3 attempts with different approaches
- The page requires something unexpected that wasn't in your instructions

Do NOT use for normal progress or minor UI quirks you can work around.
The response will contain specific guidance on how to proceed.`,
    input_schema: {
      type: 'object',
      properties: {
        problem: {
          type: 'string',
          description: 'What specific problem are you stuck on? Be precise about what element/field/action is failing.',
        },
        what_i_tried: {
          type: 'string',
          description: 'What approaches have you already attempted?',
        },
        what_i_need: {
          type: 'string',
          description: 'What specific information or guidance would unblock you?',
        },
      },
      required: ['problem', 'what_i_need'],
    },
  },
];

/**
 * Get tools filtered by URL - domain-specific tools are only included on matching domains
 * @param {string} url - Current page URL
 * @returns {Array} Filtered tool definitions (without internal _domains property)
 */
export function getToolsForUrl(url) {
  let hostname = '';
  try {
    if (url) {
      hostname = new URL(url).hostname.toLowerCase();
    }
  } catch {
    // Invalid URL, show all non-domain-specific tools
  }

  return TOOL_DEFINITIONS
    .filter(tool => {
      // If tool has no domain restriction, always include
      if (!tool._domains) return true;

      // If no URL provided, exclude domain-specific tools
      if (!hostname) return false;

      // Check if hostname matches any of the tool's domains
      return tool._domains.some(domain =>
        hostname === domain || hostname.endsWith('.' + domain)
      );
    })
    .map(tool => {
      // Remove internal _domains property before sending to API
      if (tool._domains) {
        const { _domains, ...cleanTool } = tool;
        return cleanTool;
      }
      return tool;
    });
}

/**
 * Filter out Claude-only tools for non-Claude providers
 * @param {Array} tools - Tool definitions array
 * @returns {Array} Filtered tools without Claude-specific ones
 */
export function filterClaudeOnlyTools(tools) {
  return tools.filter(tool => !CLAUDE_ONLY_TOOLS.includes(tool.name));
}
