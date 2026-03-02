# Hanzi in Chrome — MCP Server

The MCP server that connects your AI tool to the Chrome extension. Install this to give Claude Code, Cursor, Windsurf, or any MCP client browser capabilities.

## Setup

```bash
cd mcp-server
npm install
npm run build
```

Add to your MCP config (e.g., `~/.claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/path/to/hanzi-in-chrome/mcp-server/dist/index.js"]
    }
  }
}
```

**Prerequisites:** The Chrome extension must be installed and running. See the [main README](../README.md) for full setup.

## Tools

### `browser_start`

Start a browser task. **Blocks until complete** — no polling needed.

```
browser_start(
  task: "Search for flights to Tokyo on Google Flights",
  url: "https://flights.google.com",        // optional starting URL
  context: "Departing March 15, economy"     // optional extra info
)

→ {
  "session_id": "abc123",
  "status": "complete",
  "task": "Search for flights to Tokyo...",
  "answer": "Found 3 flights: JAL $850, ANA $920, United $780",
  "total_steps": 8,
  "recent_steps": ["Opened Google Flights", "Set destination to Tokyo", ...]
}
```

### `browser_message`

Send follow-up instructions to an existing session. Also blocks until the agent finishes.

```
browser_message(session_id: "abc123", message: "Book the cheapest one")
```

### `browser_status`

Check what's running.

```
browser_status()                    // all active sessions
browser_status(session_id: "abc123") // specific session
```

### `browser_stop`

Stop a task.

```
browser_stop(session_id: "abc123")
browser_stop(session_id: "abc123", remove: true)  // also delete session
```

### `browser_screenshot`

Capture the current browser state as an image.

```
browser_screenshot(session_id: "abc123")
```

## Examples

**Research:**
```
browser_start("Find the top 3 competitors for Acme Corp and summarize their pricing")
```

**Logged-in workflows:**
```
browser_start("Go to Jira, find my open tickets, and summarize what needs attention this week")
```

**Multi-turn:**
```
s = browser_start("Go to LinkedIn and find AI Engineer jobs in Montreal")
→ { session_id: "x1", answer: "Found: Applied AI Engineer at Cohere" }

browser_message("x1", "Click into that job and tell me the requirements")
→ { answer: "Requirements: 3+ years Python, ML experience..." }

browser_message("x1", "Apply to this job using my profile")
→ { answer: "Application submitted successfully" }
```

**Parallel execution:**
```
browser_start("Check flight prices to Tokyo")
browser_start("Check hotel prices in Shibuya")
browser_start("Look up train pass costs")
// All three run simultaneously
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `HANZI_IN_CHROME_MAX_SESSIONS` | `5` | Max concurrent browser tasks |
| `WS_RELAY_PORT` | `7862` | WebSocket relay port |

## Architecture

```
AI Tool (Claude Code, Cursor, etc.)
    ↓ MCP Protocol (stdio)
MCP Server (this)
    ↓ WebSocket
Relay Server (localhost:7862)
    ↓ WebSocket
Chrome Extension (user's browser)
    ↓ Browser automation
Target Website
```

The relay server starts automatically when the MCP server connects. It routes messages between the MCP server and the Chrome extension, with message queuing for when the extension's service worker is sleeping.

## License

MIT
