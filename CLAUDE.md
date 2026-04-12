## Hanzi Browse — Architecture Guide

This file is for AI agents (Claude Code, Cursor, Codex, etc.) working on this codebase. It describes what this project is, how it works, and where things live.

### What is Hanzi Browse?

A browser automation platform that gives AI agents access to a real Chrome browser with the user's signed-in sessions. The AI agent sends a task, the browser executes it autonomously.

Two distribution paths:
- **Skills** — for users who run Hanzi locally via their AI agent (Claude Code, Cursor, etc.)
- **Free tools** — public web apps that demonstrate use cases (e.g. tools.hanzilla.co/x-marketing)

Both paths require the same infrastructure: Chrome extension + site patterns + LLM.

### Architecture

```
┌─────────────────────────────────────────────────┐
│  AI Agent (Claude Code / Cursor / Codex / etc.) │
└──────────────────────┬──────────────────────────┘
                       │ MCP protocol (stdio)
              ┌────────▼────────┐
              │   MCP Server    │  server/src/index.ts
              │  (Node.js CLI)  │  5 tools: browser_start/message/status/stop/screenshot
              └────────┬────────┘
                       │ WebSocket (ws://localhost:7862)
              ┌────────▼────────┐
              │  Chrome Extension│  src/background/service-worker.js
              │  (service worker)│  13 tool handlers, CDP, DOM service
              └────────┬────────┘
                       │ Chrome DevTools Protocol
              ┌────────▼────────┐
              │   Real Browser   │  User's signed-in Chrome
              └─────────────────┘
```

**Alternative path (Managed API):**
```
Partner app → REST API (api.hanzilla.co) → Agent loop on server → Extension executes tools
```

### Key directories

| Path | What | Key files |
|------|------|-----------|
| `src/background/` | Chrome extension core | `service-worker.js`, `modules/mcp-bridge.js`, `modules/api.js`, `modules/cdp-helper.js` |
| `src/background/tool-handlers/` | 13 browser tools | `computer-core.js`, `navigation-core.js`, `form-core.js`, `read-page-core.js`, `utility-core.js` |
| `src/background/managers/` | Tab, debugger, DOM, license | `tab-manager.js`, `debugger-manager.js`, `dom-service/` |
| `server/src/` | MCP server + CLI | `index.ts` (MCP), `cli.ts` (CLI), `agent/loop.ts` (agent loop) |
| `server/src/llm/` | LLM providers | `client.ts` (unified), `vertex.ts` (Vertex AI), `credentials.ts` (key detection) |
| `server/src/managed/` | REST API backend | `api.ts` (73KB, main API), `store-pg.ts` (Postgres), `schema.sql`, `deploy.ts` |
| `server/skills/` | Agent skills (markdown) | Each skill is a `SKILL.md` with instructions |
| `server/src/agent/domain-skills.json` | Domain interaction patterns | Single source of truth for per-domain tips (x.com, linkedin, zillow, amazon…) |
| `sdk/src/` | TypeScript client | `index.ts` — HanziClient class |
| `landing/` | Marketing site (static HTML) | `index.html`, `docs.html`, `embed.js` |
| `examples/` | Demo apps | `x-marketing/` (free tool), `partner-quickstart/` (API demo) |
| `native-host/` | OAuth bridge for extension | `native-bridge.cjs` |
| `server/dashboard/` | Web UI (Preact) | `src/App.jsx` |

### Modes of operation

**1. MCP mode (local, BYOM)** — User runs `npx hanzi-browse setup`, installs extension, their AI agent uses `browser_start` tool. LLM calls happen in the extension via the user's own API key. No data leaves their machine.

**2. Managed API mode** — Partner app calls `POST /v1/tasks` with an API key. Server runs the agent loop, sends tool executions to the extension via relay. LLM is Vertex AI (Gemini). Database: Neon Postgres.

**3. Standalone sidepanel** — Direct chat UI in Chrome's side panel. User types tasks, extension executes. Uses native host for OAuth/credentials.

**4. Free tools** — Public web apps (e.g. X Marketing at tools.hanzilla.co/x-marketing). Express server calls the Hanzi API. User pairs their browser via the embed widget. Demonstrates use cases, drives extension installs.

### Skills

Skills are markdown files (`SKILL.md`) that teach AI agents when and how to use browser automation for specific workflows. They're installed into the agent's skills directory during `npx hanzi-browse setup`.

| Skill | What it does |
|-------|-------------|
| `hanzi-browse` | Core — when to use browser tools |
| `e2e-tester` | Test web apps like QA |
| `social-poster` | Post to LinkedIn/X/Reddit |
| `linkedin-prospector` | Find and connect with prospects |
| `a11y-auditor` | Run accessibility audits |
| `data-extractor` | Extract structured data from websites into CSV/JSON |
| `x-marketer` | X/Twitter marketing |

Each skill can also be built as a free tool (web app). The skill provides instructions for local agents; the free tool provides a hosted UI for anyone.

### Domain skills

Domain-specific interaction tips live in `server/src/agent/domain-skills.json` — a single JSON array shared between the server agent, the extension, and the SDK. Each entry has `domain`, `skill` (markdown body), and optional `antiBot: true`.

They're loaded into the agent's system prompt when the task URL matches a known domain (x.com, linkedin.com, gmail, github, zillow, amazon, and ~20 more). They prevent the agent from making known mistakes — e.g., using `form_input` on Draft.js editors (X, LinkedIn), which silently fails.

To add a new domain: append an entry to `server/src/agent/domain-skills.json`. The old `server/site-patterns/` directory is removed — do not re-add it.

### Build

```bash
cd server && npm run build     # TypeScript → dist/
cd .. && npm run build         # Extension → dist/ (Vite)
```

### CLI

```bash
node server/dist/cli.js start "task" --url <url> --context "extra"
node server/dist/cli.js status [session_id]
node server/dist/cli.js message <session_id> "follow-up"
node server/dist/cli.js stop <session_id> [--remove]
```

### Development

```bash
make fresh    # First time: deps + build + DB + start
make dev      # Start everything (DB + migrate + server)
make build    # Rebuild all
make stop     # Stop Postgres
```

- API: http://localhost:3456
- Dashboard: http://localhost:3456/dashboard
- Relay: ws://localhost:7862
- Extension: Load `dist/` in chrome://extensions

### Database

Production: Neon Postgres. Schema: `server/src/managed/schema.sql`.
Development: Docker Postgres on port 5433.
Tables: workspaces, api_keys, browser_sessions, task_runs, task_steps, usage_events, automations, automation_drafts, engagement_log.

### Deployment

VPS: DigitalOcean (165.227.120.122). Process manager: systemd.
Domains: api.hanzilla.co (API), relay.hanzilla.co (WebSocket), tools.hanzilla.co (free tools), browse.hanzilla.co (landing, Vercel).
Reverse proxy: Caddy (auto SSL).

Deploy: `ssh vps "cd /opt/hanzi && git pull && cd server && npm run build && systemctl restart hanzi-managed"`

### Tips

- The `--context` flag passes info the agent needs (form data, preferences, tone)
- The `--url` flag sets the starting page for the task
- The Chrome extension must be loaded and running for any mode to work
- Session state stored in `~/.hanzi-browse/sessions/`
- `chrome.tabs.group()` can move tabs across windows — MCP sessions with dedicated windows must skip tab grouping
- Extension code changes require reloading in chrome://extensions, not just restarting the server
- `read_page` returns accessibility tree; `get_page_text` returns visible text. For SPAs like X, `get_page_text` is more reliable.
- Never use `form_input` on Draft.js editors (X, Facebook). Use `javascript_tool` with `execCommand('insertText')` instead.
