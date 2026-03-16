## Browser Automation MCP Server + Chrome Extension

This project is an MCP server that controls a Chrome extension for browser automation. Send a task, the browser agent executes it autonomously. If it needs user input, it pauses and asks.

### MCP Tools

| Tool | What it does |
|------|-------------|
| `browser_start` | Start a task (blocks until complete or waiting) |
| `browser_message` | Send follow-up or answer the agent's question |
| `browser_status` | Check session status |
| `browser_stop` | Stop a session (optionally close browser window) |
| `browser_screenshot` | Capture current page as PNG |

### Architecture

```
Claude Code / Cursor (MCP client)
  → MCP Server (server/src/index.ts) via stdio
  → WebSocket relay (ws://localhost:7862)
  → Chrome Extension (service-worker.js)
  → Browser agent makes LLM calls via native host
  → Native host reads local credentials + proxies API calls
```

All LLM calls happen in the extension via `api.js` → native host. The MCP server does NOT call LLMs directly — it only routes tasks to the extension.

### CLI Usage

```bash
node server/dist/cli.js start "task description" --url <url> --context "extra context"
node server/dist/cli.js status [session_id]
node server/dist/cli.js message <session_id> "follow-up"
node server/dist/cli.js stop <session_id> [--remove]
```

### Build

```bash
cd server && npm run build
```

### Tips

- The `--context` flag passes info the agent needs (form data, preferences, tone)
- The `--url` flag sets the starting page
- The Chrome extension must be loaded and running
- Session state is stored in `~/.hanzi-in-chrome/sessions/`
