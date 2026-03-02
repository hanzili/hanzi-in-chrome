# Hanzi in Chrome

Give your AI agent a browser agent. Works with Claude Code, Cursor, Windsurf, Codex CLI, and anything that supports MCP.

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/iklpkemlmbhemkiojndpbhoakgikpmcd)](https://chrome.google.com/webstore/detail/iklpkemlmbhemkiojndpbhoakgikpmcd)

## Demo

[![demo video](https://img.youtube.com/vi/cal0k351Rwo/maxresdefault.jpg)](https://youtu.be/cal0k351Rwo)

## Why?

Other browser tools (Playwright MCP, Browser Use) give your AI a **new, empty browser**. Every click is a separate tool call. Logging in is a nightmare.

This gives your AI **your actual Chrome** — already logged into Gmail, GitHub, Jira, everything. It delegates the entire task to a browser agent that handles all the clicking and typing autonomously.

```
# Other tools: 50+ tool calls, one click at a time
ai: click login button
ai: type username
ai: type password
ai: click submit
ai: wait for page load
ai: click menu
... (you get the idea)

# This: 1 tool call, entire task delegated
ai: browser_start("Log into Jira and summarize my open tickets")
ai: → { status: "complete", answer: "You have 3 open tickets..." }
```

## Quick Start

### 1. Install the Chrome extension

**[Install from Chrome Web Store](https://chrome.google.com/webstore/detail/iklpkemlmbhemkiojndpbhoakgikpmcd)**

### 2. Give the extension an LLM

The extension runs its own browser agent — an LLM that reads pages, clicks, types, and navigates autonomously. You need to give it access to an LLM. Pick one:

**Option A: Use your Claude or Codex subscription (no extra cost)**

```bash
# Log in if you haven't already
claude login    # for Claude Pro/Max subscribers
# or
codex login     # for ChatGPT Pro/Plus subscribers

# Then install the credential bridge (Chrome extensions can't read local files,
# so this small helper reads your login credentials and passes them to the extension)
curl -fsSL https://raw.githubusercontent.com/hanzili/hanzi-in-chrome/main/install.sh | bash
```

Open the extension settings → click "Connect" under your plan.

**Option B: Use an API key (no bridge needed)**

Open the extension settings and paste a key from [Anthropic](https://console.anthropic.com), [OpenAI](https://platform.openai.com), [Google](https://aistudio.google.com), or [OpenRouter](https://openrouter.ai).

---

**Done!** The extension now works on its own. Open the side panel on any page and tell the agent what to do.

If you also want your AI coding tool (Claude Code, Cursor, etc.) to use it, continue to step 3.

---

### 3. Connect to your AI coding tool (optional)

This adds the browser as an MCP tool so Claude Code, Cursor, or any MCP client can call it:

```bash
git clone https://github.com/hanzili/hanzi-in-chrome.git
cd hanzi-in-chrome/mcp-server && npm install && npm run build
```

Add to your MCP config:

<details>
<summary><strong>Claude Code</strong> (~/.claude/claude_desktop_config.json)</summary>

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/absolute/path/to/hanzi-in-chrome/mcp-server/dist/index.js"]
    }
  }
}
```
</details>

<details>
<summary><strong>Cursor</strong> (.cursor/mcp.json)</summary>

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/absolute/path/to/hanzi-in-chrome/mcp-server/dist/index.js"]
    }
  }
}
```
</details>

<details>
<summary><strong>Windsurf / Other MCP clients</strong></summary>

Point your MCP client to:
```
node /absolute/path/to/hanzi-in-chrome/mcp-server/dist/index.js
```
</details>

That's it. Your AI can now use your browser.

## What You Can Do

### Web research
```
browser_start("Search for 'MCP protocol' on Google and summarize the first 3 results")
```

### Logged-in tasks
```
browser_start("Go to Gmail and unsubscribe from all marketing emails from the last week")
```

### Form filling
```
browser_start(
  "Apply for the senior engineer position on careers.acme.com",
  context="Name: Jane Doe, Email: jane@example.com, Experience: 10 years Python..."
)
```

### Multi-step workflows
```
browser_start("Log into my bank and download last month's statement")
```

### Follow-up messages
```
session = browser_start("Find AI engineer jobs on LinkedIn in San Francisco")
# → { session_id: "abc123", status: "complete", answer: "Found 5 results..." }

browser_message("abc123", "Apply to the first one using my profile")
```

### Parallel tasks
```
browser_start("Search for flights to Tokyo on Google Flights")
browser_start("Check hotel prices in Shibuya on Booking.com")
browser_start("Look up JR Pass costs")
# All three run simultaneously in separate windows
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `browser_start` | Run a task. Blocks until complete, returns the result. |
| `browser_message` | Send follow-up instructions to an existing session. |
| `browser_status` | Check progress of active tasks. |
| `browser_stop` | Stop a task. |
| `browser_screenshot` | Capture current browser state. |

## CLI

There's also a CLI for running tasks from the terminal:

```bash
# Start a task (blocks until complete)
node mcp-server/dist/cli.js start "Search for AI news" --url https://google.com

# Check status
node mcp-server/dist/cli.js status

# Watch logs in real-time
node mcp-server/dist/cli.js logs <session_id> --follow

# Send follow-up message
node mcp-server/dist/cli.js message <session_id> "Click the first result"

# Stop a task
node mcp-server/dist/cli.js stop <session_id>
```

## How It Works

```
Claude Code / Cursor / AI Tool
        ↓ MCP Protocol (stdio)
   MCP Server
        ↓ WebSocket (localhost:7862)
   Chrome Extension (your browser)
        ↓ Browser automation
   Target Website
```

1. Your AI tool calls `browser_start` with a task description
2. The MCP server sends it to the Chrome extension via WebSocket relay
3. The extension's built-in agent handles all browser interaction autonomously
4. Results flow back to your AI tool

The browser agent uses an accessibility tree to understand pages, not screenshots. It clicks, types, scrolls, navigates, and manages tabs — all on its own.

## Comparison

| | Hanzi in Chrome | Playwright MCP | Browser Use |
|---|---|---|---|
| **Abstraction** | Task-level (1 call) | Action-level (50+ calls) | Action-level (50+ calls) |
| **Browser** | Your real Chrome | New headless browser | New Chromium instance |
| **Logged-in sites** | Already authenticated | Must handle auth | Must handle auth |
| **Setup** | Chrome extension | Playwright + Node | Python + pip |
| **Parallel tasks** | Built-in | Manual | Manual |
| **Session follow-ups** | Built-in | N/A | N/A |

## Using as a Standalone Extension

The extension also works on its own without the MCP server — just open the side panel and chat with the agent directly. It supports multiple LLM providers (Claude, GPT, Gemini, Mistral, Qwen) and can be configured through the extension settings.

## Development

```bash
# Load unpacked extension
git clone https://github.com/hanzili/hanzi-in-chrome.git
# Open chrome://extensions → Enable Developer Mode → Load Unpacked → select the repo

# Build MCP server
cd mcp-server && npm install && npm run build

# Watch for changes
cd mcp-server && npm run dev
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make changes
4. Submit a pull request

## License

MIT
