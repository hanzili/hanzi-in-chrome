<div align="center">

[English](README.md) | [中文](docs/zh/README.md)

<img src="docs/logo.svg" width="80" alt="Hanzi Browse" />

# Hanzi Browse

**The context layer for browsing agents.**

Your browsing agent keeps failing on real sites — X uses Draft.js, LinkedIn hides the<br/>
connect button, Gmail needs keyboard shortcuts. Hanzi Browse ships 24 site playbooks —<br/>
**hints for the LLM, not brittle scripts** — so it actually finishes the task.

[![npm](https://img.shields.io/npm/v/hanzi-browse?color=%23cb3837&label=npm)](https://www.npmjs.com/package/hanzi-browse)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/iklpkemlmbhemkiojndpbhoakgikpmcd?label=chrome%20web%20store&color=%234285F4)](https://chrome.google.com/webstore/detail/iklpkemlmbhemkiojndpbhoakgikpmcd)
[![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/hahgu5hcA5)
[![License](https://img.shields.io/badge/license-PolyForm%20NC-green)](LICENSE)

**Works with**

<a href="https://claude.ai/code"><img src="https://browse.hanzilla.co/logos/claude-logo-0p9b6824.png" width="28" height="28" alt="Claude Code" title="Claude Code"></a>&nbsp;&nbsp;
<a href="https://cursor.com"><img src="https://browse.hanzilla.co/logos/cursor-logo-5jxhjn17.png" width="28" height="28" alt="Cursor" title="Cursor"></a>&nbsp;&nbsp;
<a href="https://openai.com/codex"><img src="https://browse.hanzilla.co/logos/openai-logo-6323x4zd.png" width="24" height="24" alt="Codex" title="Codex"></a>&nbsp;&nbsp;
<a href="https://ai.google.dev/gemini-api/docs/cls"><img src="https://browse.hanzilla.co/logos/gemini-logo-1f6kvbwc.png" width="24" height="24" alt="Gemini CLI" title="Gemini CLI"></a>&nbsp;&nbsp;
<img src="https://browse.hanzilla.co/logos/github-logo-tr9d8349.png" width="24" height="24" alt="VS Code" title="VS Code">&nbsp;&nbsp;
<img src="https://browse.hanzilla.co/logos/kiro-logo-wk3s9bcy.png" width="24" height="24" alt="Kiro" title="Kiro">&nbsp;&nbsp;
<img src="https://browse.hanzilla.co/logos/antigravity-logo-szj1gjgv.png" width="24" height="24" alt="Antigravity" title="Antigravity">&nbsp;&nbsp;
<img src="https://browse.hanzilla.co/logos/opencode-logo-svpy0wcb.png" width="24" height="24" alt="OpenCode" title="OpenCode">


<br/>

[![Watch demo](https://img.youtube.com/vi/3tHzg2ps-9w/maxresdefault.jpg)](https://www.youtube.com/watch?v=3tHzg2ps-9w)

</div>

<br/>

## Two ways to use Hanzi Browse

Same 24 site playbooks underneath. Two install paths depending on who's driving.

### For your agent — a browser sub-agent for your coding agent

One command. `npx hanzi-browse setup` detects every AI agent on your machine (Claude Code, Cursor, Codex, and 9 more) and wires Hanzi Browse in as an MCP tool. Your main agent delegates browser work; a sub-agent runs the loop — *read page → plan next action → click/type/scroll → observe → repeat until done* — and returns a clean answer. Site playbooks auto-load by URL so the model already knows the quirks.

![Use it now](docs/diagrams/use-it.svg)

### For your product — browser automation for your users, described in English

Your backend calls `runTask({ task: "…" })`. Your users' own Chrome executes it, signed in as themselves. Same 24 playbooks as the CLI, exposed as a REST API and `@hanzi-browse/sdk`. Free tools on [tools.hanzilla.co](https://tools.hanzilla.co) are built on this SDK.

![Build with it](docs/diagrams/build-with-it.svg)

<br/>

## Get Started

```bash
npx hanzi-browse setup
```

One command does everything:

```
npx hanzi-browse setup
│
├── 1. Detect browsers ──── Chrome, Brave, Edge, Arc, Chromium
│
├── 2. Install extension ── Opens Chrome Web Store, waits for install
│
├── 3. Detect AI agents ─── Claude Code, Cursor, Codex, Windsurf,
│                           VS Code, Gemini CLI, Amp, Cline, Roo Code
│
├── 4. Configure MCP ────── Merges hanzi-browse into each agent's config
│
├── 5. Install skills ───── Copies browser skills into each agent
│
└── 6. Choose AI mode ───── Managed ($0.05/task) or BYOM (free forever)
```

- **Managed** — we handle the AI. 20 free tasks/month, then $0.05/task. No API key needed.
- **BYOM** — use your Claude Pro/Max subscription, GPT Plus, or any API key. Free forever, runs locally.


<br/>

## Examples

```
"Go to Gmail and unsubscribe from all marketing emails from the last week"
"Apply for the senior engineer position on careers.acme.com"
"Log into my bank and download last month's statement"
"Find AI engineer jobs on LinkedIn in San Francisco"
```

<br/>

## Skills & Free Tools

Hanzi Browse has two distribution channels. Both use the same browser automation engine and site domain knowledge:

**Skills** — for users who run Hanzi Browse locally through their AI agent. The setup wizard installs skills directly into your agent (Claude Code, Cursor, etc.). Each skill teaches the agent *when* and *how* to use the browser for a specific workflow.

**Free Tools** — hosted web apps that anyone can try without installing anything. Each tool is a standalone app built on the Hanzi Browse API that demonstrates a use case. Every skill can become a free tool.

### Skills

Installed automatically during `npx hanzi-browse setup`. Your agent reads these as markdown files.

| Skill | Description |
|-------|-------------|
| `hanzi-browse` | Core skill — when and how to use browser automation |
| `e2e-tester` | Test your app in a real browser, report bugs with screenshots |
| `social-poster` | Draft per-platform posts, publish from your signed-in accounts |
| `linkedin-prospector` | Find prospects, send personalized connection requests |
| `a11y-auditor` | Run accessibility audits in a real browser |
| `data-extractor` | Extract structured data from websites into CSV/JSON |
| `x-marketer` | Twitter/X marketing workflows |

Open source — [add your own](https://github.com/hanzili/hanzi-browse/tree/main/server/skills).

### Free Tools

Try them at [tools.hanzilla.co](https://tools.hanzilla.co). No account needed — just install the extension and go.

| Tool | What it does | Try it |
|------|-------------|--------|
| X Marketing | AI finds relevant conversations on X, drafts personalized replies, posts from your Chrome | [tools.hanzilla.co/x-marketing](https://tools.hanzilla.co/x-marketing) |

### Site Playbooks — the context layer

Both CLI and SDK rely on a shared set of **site playbooks** — verified interaction recipes for complex websites. They teach the LLM how async loading works on X, which selector hides LinkedIn's connect button, that Gmail responds to keyboard shortcuts, and how to sidestep anti-bot detection on ~20 other sites.

**Hints for the LLM, not brittle scripts.** The model stays in control; we just hand it the cheat sheet. When the DOM shifts, the agent adapts — no adapter to rebuild.

**Currently supports 24 sites:** X, LinkedIn, Gmail, GitHub, Notion, Figma, Slack, Reddit, Amazon, eBay, Walmart, Target, Zillow, Apartments.com, Craigslist, Indeed, Google Docs, Sheets, Calendar, Drive, ChatGPT, Claude.ai, Stack Overflow.

All playbooks live in [`server/src/agent/domain-skills.json`](server/src/agent/domain-skills.json) as a single shared JSON array. To add a site, open a PR appending a `{ domain, skill }` entry.

<br/>

## Build with Hanzi Browse

Embed browser automation in your product. Your app calls the Hanzi Browse API, a real browser executes the task, you get the result back.

1. **Get an API key** — [sign in](https://api.hanzilla.co/dashboard) to your developer console, then create a key
2. **Pair a browser** — create a pairing token, send your user a pairing link (`/pair/{token}`) — they click it and auto-pair
3. **Run a task** — `POST /v1/tasks` with a task and browser session ID
4. **Get the result** — poll `GET /v1/tasks/:id` until complete, or use `runTask()` which blocks

```typescript
import { HanziClient } from '@hanzi-browse/sdk';

const client = new HanziClient({ apiKey: process.env.HANZI_API_KEY });

const { pairingToken } = await client.createPairingToken();
const sessions = await client.listSessions();

const result = await client.runTask({
  browserSessionId: sessions[0].id,
  task: 'Read the patient chart on the current page',
});
console.log(result.answer);
```

[API reference](https://browse.hanzilla.co/docs.html#build-with-hanzi) · [Dashboard](https://api.hanzilla.co/dashboard) · [Sample integration](examples/partner-quickstart/)

<br/>

## Tools

| Tool | Description |
|------|-------------|
| `browser_start` | Run a task. Blocks until complete. |
| `browser_message` | Send follow-up to an existing session. |
| `browser_status` | Check progress. |
| `browser_stop` | Stop a task. |
| `browser_screenshot` | Capture current page as image. |

<br/>

## Pricing

| | Managed | BYOM |
|--|---------|------|
| **Price** | $0.05/task (20 free/month) | Free forever |
| **AI model** | We handle it (Gemini) | Your own key |
| **Data** | Processed on Hanzi Browse servers | Never leaves your machine |
| **Billing** | Only completed tasks. Errors are free. | N/A |

Building a product? [Contact us](mailto:hanzili0217@gmail.com?subject=Partner%20pricing) for volume pricing.

<br/>

## Development

**Prerequisites:** [Node.js 18+](https://nodejs.org/), [Docker Desktop](https://docs.docker.com/get-docker/) (must be running before `make fresh`).

### First time (local setup)

```bash
git clone https://github.com/hanzili/hanzi-browse
cd hanzi-browse
make fresh
```

Performs full setup: installs deps, builds server/dashboard/extension, starts Postgres, runs migrations, and launches the dev server (~90s).

### Run the project

```bash
make dev
```

Starts the backend services (Postgres + migrations + API server) and serves the dashboard UI.
- API: http://localhost:3456
- Dashboard (requires Google OAuth): http://localhost:3456/dashboard

### Configuration

The defaults in `.env.example` are enough to run the server.

Optional services:
- **Google OAuth** (dashboard sign-in) -- add `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` to `.env`
- **Stripe** (credit purchases) -- add test keys to `.env`
- **Vertex AI** (managed task execution) -- see `.env.example` for setup steps
- **PostHog** (analytics) -- add `POSTHOG_API_KEY` to enable local CLI telemetry, dashboard analytics, managed backend analytics, and the example apps; optionally set `POSTHOG_HOST`

### Load the extension

Open `chrome://extensions`, enable Developer Mode, click "Load unpacked", and select the project root (the folder that contains `manifest.json`).

### Verify everything works

After `make dev` is running and the extension is loaded, test both user paths:

**Test 1: MCP / CLI mode (user path)**

```bash
# In a separate terminal:
node server/dist/cli.js start "Go to example.com and tell me the page title"
```

You should see a Chrome window open, the agent navigate to example.com, and return the page title. If this works, the relay + extension + agent loop are all connected.

**Test 2: Managed API mode (developer path)**

```bash
# 1. Check the API is running
curl http://localhost:3456/v1/health

# 2. Open the dashboard and sign in (requires Google OAuth configured)
open http://localhost:3456/dashboard

# 3. Create an API key from the dashboard, then:
curl -X POST http://localhost:3456/v1/browser-sessions/pair \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json"

# 4. Open the pairing URL in Chrome (from the response)
open "http://localhost:3456/pair/PAIRING_TOKEN"

# 5. After pairing, run a task
curl -X POST http://localhost:3456/v1/tasks \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"task": "Go to example.com and read the title", "browser_session_id": "SESSION_ID"}'

# 6. Check the result
curl http://localhost:3456/v1/tasks/TASK_ID \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Test 3: Embed widget**

Create a test HTML file and open it in Chrome:

```html
<div id="hanzi"></div>
<script src="http://localhost:3456/embed.js"></script>
<script>
  HanziConnect.mount('#hanzi', {
    apiKey: 'YOUR_PUBLISHABLE_KEY',
    apiUrl: 'http://localhost:3456',
    onConnected: (id) => console.log('Connected:', id),
    onError: (err) => console.log('Error:', err),
  });
</script>
```

You should see the pairing widget with step-by-step instructions.

### Notes

- **Local vs CLI usage** -- `npx hanzi-browse setup` is for packaged usage and may not work in a local clone
- **Port conflicts** -- if you see `EADDRINUSE` on `3456`, stop existing processes or run `make stop`
- **No Google OAuth?** -- The dashboard sign-in won't work, but you can seed a test workspace directly in the database and use the API key for testing

### Commands

| Command | What it does |
|---------|-------------|
| `make fresh` | Full first-time setup (deps + build + DB + start) |
| `make dev` | Start everything (DB + migrate + server) |
| `make build` | Rebuild server + dashboard + extension |
| `make stop` | Stop Postgres |
| `make clean` | Stop + delete database volume |
| `make check-prereqs` | Verify Node 18+ and Docker are available |
| `make help` | Show all commands |

<br/>

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions.

Good first contributions: new skills, landing pages, site-pattern files, platform testing, translations. Check the [open issues](https://github.com/hanzili/hanzi-browse/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

<br/>

## Community

[Discord](https://discord.gg/hahgu5hcA5) · [Documentation](https://browse.hanzilla.co/docs.html) · [Twitter](https://x.com/user)

<br/>

## Privacy

Hanzi Browse operates in different modes with different data handling. [Read the privacy policy](PRIVACY.md).

- **BYOM**: No data sent to Hanzi Browse servers. Screenshots go to your chosen AI provider only.
- **Managed / API**: Task data processed on Hanzi Browse servers via Google Vertex AI.

<br/>

## License

[Polyform Noncommercial 1.0.0](LICENSE)
