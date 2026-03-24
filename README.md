# Your agent stops when it needs a browser. Hanzi lets it keep going.

**Hanzi** gives your AI agent your real signed-in browser. One tool call, entire task delegated.

Works with Claude Code, Claude Cowork, Cursor, Codex, Windsurf, and more.

[![Watch demo](https://img.youtube.com/vi/3tHzg2ps-9w/maxresdefault.jpg)](https://www.youtube.com/watch?v=3tHzg2ps-9w)

## Use Hanzi now

```bash
npx hanzi-in-chrome setup
```

Detects your browsers, installs the extension, finds AI agents on your machine (Claude Code, Cursor, etc.), and adds Hanzi to each one.

### Access modes

The CLI sets up **BYOM (bring your own model)** — this is the self-serve path that works today. You provide your own Claude, GPT, or Gemini API key. Everything runs locally.

**Managed access** is a separate path where we handle model routing — no API key needed. It is not yet part of the CLI and is set up separately by request. [Contact us](mailto:hanzili0217@gmail.com?subject=Managed%20access) to get started.

<details>
<summary>Manual setup</summary>

1. **[Install the browser extension](https://chrome.google.com/webstore/detail/iklpkemlmbhemkiojndpbhoakgikpmcd)**

2. Add the MCP server:

**Claude Code:**
```bash
claude mcp add browser -- npx -y hanzi-in-chrome
```

**Cursor / Windsurf / Others** (mcp.json):
```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "hanzi-in-chrome"]
    }
  }
}
```

3. Credentials — pick one:
   - Claude Pro/Max: uses `claude login` automatically
   - Codex: run `codex login`
   - API key: set `ANTHROPIC_API_KEY`
</details>

## Build with Hanzi

Embed browser automation in your product. Your app calls the Hanzi API, a real browser executes the task, you get the result back.

### How it works

1. **Get an API key** — [sign in](https://api.hanzilla.co/api/auth/sign-in/social) to open your developer console, then create a key
2. **Pair a browser** — create a pairing token, have your user enter it in the extension
3. **Run a task** — call the API with a task and a browser session ID
4. **Get the result** — poll the task or use `runTask()` which blocks until done

### SDK

The SDK source is in [`sdk/`](https://github.com/hanzili/llm-in-chrome/tree/main/sdk). It is not yet published to npm — clone the repo and install from `sdk/` directly.

```typescript
import { HanziClient } from '@hanzi/browser-agent';

const client = new HanziClient({ apiKey: process.env.HANZI_API_KEY });

// Create a pairing token for your user
const { pairingToken } = await client.createPairingToken();
// → show this token in your UI

// List connected sessions
const sessions = await client.listSessions();

// Run a task in the user's browser
const result = await client.runTask({
  browserSessionId: sessions[0].id,
  task: 'Read the patient chart on the current page',
});
console.log(result.answer);
```

[API reference](https://browse.hanzilla.co/docs.html#build-with-hanzi) · [Sign in](https://api.hanzilla.co/api/auth/sign-in/social) · [Sample integration](examples/partner-quickstart/)

## Examples

```
"Go to Gmail and unsubscribe from all marketing emails from the last week"
"Apply for the senior engineer position on careers.acme.com"
"Log into my bank and download last month's statement"
"Find AI engineer jobs on LinkedIn in San Francisco"
```

## Skills

Reusable workflows. Open source — [add your own](https://github.com/hanzili/llm-in-chrome/tree/main/server/skills).

| Skill | Description |
|-------|-------------|
| `linkedin-prospector` | Find prospects, send personalized connection requests |
| `e2e-tester` | Test your app in a real browser, report bugs with screenshots |
| `social-poster` | Draft per-platform posts, publish from your signed-in accounts |

## Tools

| Tool | Description |
|------|-------------|
| `browser_start` | Run a task. Blocks until complete. |
| `browser_message` | Send follow-up to an existing session. |
| `browser_status` | Check progress. |
| `browser_stop` | Stop a task. |
| `browser_screenshot` | Capture current page as PNG. |

## Development

Prerequisites: [Docker](https://docs.docker.com/get-docker/), Node.js 18+.

```bash
git clone https://github.com/hanzili/hanzi-in-chrome
cd hanzi-in-chrome
make dev
```

This starts Postgres, runs migrations, builds the server + dashboard + extension, and starts the dev servers. Edit `.env` for Google OAuth credentials if you want sign-in to work.

| Command | What it does |
|---------|-------------|
| `make dev` | Start everything |
| `make build` | Build server + dashboard + extension |
| `make stop` | Stop Postgres |
| `make clean` | Stop + delete database |
| `make help` | Show all commands |

Load the extension: open `chrome://extensions`, enable Developer Mode, click "Load unpacked", select the `dist/` folder.

## Community

[Join our Discord](https://discord.gg/hahgu5hcA5) · [Documentation](https://browse.hanzilla.co/docs.html)

## Privacy

Hanzi operates in different modes with different data handling. [Read the privacy policy](PRIVACY.md).

- **BYOM**: No data sent to Hanzi servers. Screenshots go to your chosen AI provider only.
- **Managed / API**: Task data processed on Hanzi servers via Google Vertex AI.

## License

[Polyform Noncommercial 1.0.0](LICENSE)
