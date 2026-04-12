# Hanzi Browse

Give your AI agent a real browser — with your existing logins, cookies, and sessions.

**Two ways to use it:**
- **Use locally** — MCP server for Claude Code, Cursor, Codex, and other AI coding agents
- **Build with it** — REST API + TypeScript SDK for embedding browser automation in your product

## Quick Start (MCP)

```bash
npx hanzi-browse setup
```

This installs the Chrome extension and configures your AI agent. One command, done.

**Prerequisites:** Chrome must be open with the [Hanzi extension](https://chromewebstore.google.com/detail/hanzi-browse/iklpkemlmbhemkiojndpbhoakgikpmcd) installed.

## Quick Start (API)

```bash
npm install @hanzi-browse/sdk
```

```typescript
import { HanziClient } from '@hanzi-browse/sdk';

const client = new HanziClient({ apiKey: 'hic_live_...' });

// 1. Pair a browser — give the URL to your user
const { pairingToken } = await client.createPairingToken();
// User visits: https://api.hanzilla.co/pair/{pairingToken}

// 2. Find their connected session
const sessions = await client.listSessions();
const browser = sessions.find(s => s.status === 'connected');

// 3. Run a task (polls until complete)
const result = await client.runTask({
  browserSessionId: browser.id,
  task: 'Go to example.com and read the page title',
});
console.log(result.answer);
```

Full API docs: [browse.hanzilla.co/docs.html](https://browse.hanzilla.co/docs.html)

## MCP Tools

### `browser_start`

Start a browser task. **Blocks until complete or timeout**.

```
browser_start(
  task: "Search for flights to Tokyo on Google Flights",
  url: "https://flights.google.com",        // optional starting URL
  context: "Departing March 15, economy"     // optional extra info
)

→ {
  "session_id": "abc123",
  "status": "complete",
  "answer": "Found 3 flights: JAL $850, ANA $920, United $780",
  "total_steps": 8,
  "recent_steps": ["Opened Google Flights", "Set destination to Tokyo", ...]
}
```

### `browser_message`

Send follow-up instructions to an existing session.

```
browser_message(session_id: "abc123", message: "Book the cheapest one")
```

### `browser_status`

Check known sessions and their latest status.

```
browser_status()                     // all active sessions
browser_status(session_id: "abc123") // specific session
```

### `browser_stop`

Stop a task.

```
browser_stop(session_id: "abc123")
browser_stop(session_id: "abc123", remove: true)  // also close window
```

### `browser_screenshot`

Capture the current browser state as an image.

```
browser_screenshot(session_id: "abc123")
```

## Examples

**Logged-in workflows:**
```
browser_start("Go to Jira, find my open tickets, and summarize what needs attention")
```

**Multi-turn:**
```
s = browser_start("Go to LinkedIn and find AI Engineer jobs in Montreal")
browser_message(s.session_id, "Click into the Cohere job and tell me the requirements")
browser_message(s.session_id, "Apply to this job using my profile")
```

**Parallel execution:**
```
browser_start("Check flight prices to Tokyo")
browser_start("Check hotel prices in Shibuya")
// Both run simultaneously in separate windows
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `HANZI_BROWSE_MAX_SESSIONS` | `5` | Max concurrent browser tasks |
| `HANZI_BROWSE_TIMEOUT_MS` | `300000` | Task timeout (ms) |
| `WS_RELAY_PORT` | `7862` | WebSocket relay port |

## Skills

The server exposes MCP prompts that clients auto-discover:

| Prompt | Description |
|--------|-------------|
| `linkedin-prospector` | Goal-driven LinkedIn outreach |
| `e2e-tester` | Test your app in a real browser with screenshots |
| `social-poster` | Post across LinkedIn, Twitter, Reddit from your browser |
| `x-marketer` | Find X/Twitter conversations and draft voice-matched replies |

```bash
hanzi-browser skills                              # list available skills
hanzi-browser skills install linkedin-prospector   # install SKILL.md to your project
```

## Architecture

```
AI Agent (Claude Code, Cursor, etc.)
    ↓ MCP Protocol (stdio)
MCP Server (this package)
    ↓ WebSocket
Chrome Extension
    ↓ Chrome DevTools Protocol
User's Real Browser
```

> **Principle**: Hanzi is for real browser work in your signed-in Chrome.
> Agents should prefer code, logs, APIs, and existing tools first. Use Hanzi when the job needs a real browser session.

## License

[Polyform Noncommercial 1.0.0](../LICENSE)
