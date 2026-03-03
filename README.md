# Stop being your AI's intern.

Your AI agent can't use a browser. So it makes you do it — open this URL, click that button, paste the result back. Over and over.

**Hanzi in Chrome** is a browser agent that lives inside your MCP. It takes over your real Chrome — your logins, your sessions — and browses, clicks, and fills forms autonomously.

Works with Claude Code, Cursor, Windsurf, Codex CLI, and anything that supports MCP.

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/iklpkemlmbhemkiojndpbhoakgikpmcd)](https://chrome.google.com/webstore/detail/iklpkemlmbhemkiojndpbhoakgikpmcd)

## Demo

![Demo](demo.gif)

## Why not Playwright MCP / Browser Use?

Those tools give your AI a **new, empty browser**. Every click is a separate tool call. Logging in is a nightmare.

This gives your AI **your actual Chrome** — already logged into Gmail, GitHub, Jira, everything. One tool call, entire task delegated.

```
# Other tools: 50+ tool calls, one click at a time
ai: click login button
ai: type username
ai: type password
ai: click submit
ai: wait for page load
ai: click menu
... (you get the idea)

# Hanzi in Chrome: 1 tool call, done
ai: browser_start("Log into Jira and summarize my open tickets")
ai: → "You have 3 open tickets..."
```

## Setup

### 1. Install the Chrome extension

**[Install from Chrome Web Store](https://chrome.google.com/webstore/detail/iklpkemlmbhemkiojndpbhoakgikpmcd)**

### 2. Add the MCP server to your AI tool

The agent needs an LLM to drive the browser. Pick one:

- **Claude Pro/Max subscriber?** You're set — it uses your `claude login` automatically.
- **Codex subscriber?** Run `codex login` and you're set.
- **API key?** Set `ANTHROPIC_API_KEY` in your environment.

<details open>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add browser -- npx -y hanzi-in-chrome-mcp
```
</details>

<details>
<summary><strong>Cursor</strong> (.cursor/mcp.json)</summary>

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "hanzi-in-chrome-mcp"]
    }
  }
}
```
</details>

<details>
<summary><strong>Windsurf / Other MCP clients</strong></summary>

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "hanzi-in-chrome-mcp"]
    }
  }
}
```
</details>

That's it. Your AI can now use your browser.

## What you can do

**Logged-in tasks** — it's your Chrome, you're already authenticated
```
browser_start("Go to Gmail and unsubscribe from all marketing emails from the last week")
```

**Form filling**
```
browser_start("Apply for the senior engineer position on careers.acme.com. Name: Jane Doe, Email: jane@example.com, Experience: 10 years Python")
```

**Multi-step workflows**
```
browser_start("Log into my bank and download last month's statement")
```

**Parallel tasks** — each runs in its own browser window
```
browser_start("Search for flights to Tokyo on Google Flights")
browser_start("Check hotel prices in Shibuya on Booking.com")
browser_start("Look up JR Pass costs")
```

**Follow-ups** — the browser window stays open
```
session = browser_start("Find AI engineer jobs on LinkedIn in San Francisco")
browser_message(session_id, "Apply to the first one using my profile")
```

## Pricing

**Free:** 100 tasks, no credit card needed.

**Pro:** $29 one-time for unlimited tasks. **[Buy Pro](https://hanziinchrome.lemonsqueezy.com/checkout/buy/5f9be29a-b862-43bf-a440-b4a3cdc9b28e)**

After purchasing, set your license key:
```bash
export HANZI_IN_CHROME_LICENSE_KEY=your-key-here
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `browser_start` | Run a task. Blocks until complete, returns the result. |
| `browser_message` | Send follow-up instructions to an existing session. |
| `browser_status` | Check progress of active tasks. |
| `browser_stop` | Stop a task. |
| `browser_screenshot` | Capture current browser state as PNG. |

## How it works

```
Your AI tool (Claude Code, Cursor, etc.)
        ↓ MCP Protocol
   Hanzi MCP Server (runs locally via npx)
        ↓ WebSocket
   Chrome Extension (your real browser)
        ↓ Autonomous agent
   Websites (with your logins)
```

1. Your AI calls `browser_start` with a task
2. The MCP server sends it to the Chrome extension
3. The browser agent handles all interaction autonomously
4. Results flow back to your AI

## Comparison

| | Hanzi in Chrome | Playwright MCP | Browser Use |
|---|---|---|---|
| **Abstraction** | Task-level (1 call) | Action-level (50+ calls) | Action-level (50+ calls) |
| **Browser** | Your real Chrome | New headless browser | New Chromium instance |
| **Logged-in sites** | Already authenticated | Must handle auth | Must handle auth |
| **Setup** | Chrome extension + npx | Playwright + Node | Python + pip |
| **Parallel tasks** | Built-in | Manual | Manual |

## Development

```bash
git clone https://github.com/hanzili/hanzi-in-chrome.git
cd mcp-server && npm install && npm run build
```

## License

MIT
