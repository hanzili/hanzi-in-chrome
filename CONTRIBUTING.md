# Contributing to Hanzi

Thanks for wanting to contribute! Here's what you need to know.

## Setup

Prerequisites: [Docker](https://docs.docker.com/get-docker/), Node.js 18+, a Chromium browser.

```bash
git clone https://github.com/hanzili/hanzi-in-chrome
cd hanzi-in-chrome
make dev
```

This will:
1. Create a `.env` file from `.env.example` (edit it for Google OAuth if you want sign-in)
2. Install all dependencies (root, server, dashboard, SDK)
3. Build the server, dashboard, and extension
4. Start Postgres via Docker on port 5433
5. Run database migrations
6. Start the managed API server on port 3456

Load the extension: open `chrome://extensions`, enable Developer Mode, click "Load unpacked", select the `dist/` folder in the repo root.

## Commands

| Command | What it does |
|---------|-------------|
| `make dev` | Start everything for local development |
| `make build` | Build server + dashboard + extension |
| `make db` | Start Postgres only |
| `make migrate` | Run database schema on local Postgres |
| `make stop` | Stop Postgres |
| `make clean` | Stop + delete database volume |
| `make help` | Show all commands |

## Architecture

```
Website (landing/)         → static HTML, no build step
Extension (src/)           → Preact, built with Vite (dist/)
MCP Server (server/src/)   → TypeScript, built with tsc (server/dist/)
Dashboard (server/dashboard/) → Preact + Vite (server/dist/dashboard/)
SDK (sdk/)                 → TypeScript (sdk/dist/)
```

Two product paths:
- **Use Hanzi now** — CLI-first. `npx hanzi-in-chrome setup` configures local BYOM usage.
- **Build with Hanzi** — API/dashboard-first. Sign in → developer console → create key → pair browser → run tasks.

Key internal docs:
- `docs/internal/PRODUCT_MODEL.md` — product paths, access modes, surface roles
- `docs/internal/PRODUCTION_READINESS.md` — current state, what's ready, what's not
- `docs/internal/PRODUCTION_LAUNCH_SPEC.md` — what must be built for production

## What to work on

### Good first contributions

- **New skills** — just a `SKILL.md` file. See `server/skills/linkedin-prospector/SKILL.md` for the pattern.
- **Landing page** — pure HTML in `landing/`. No build step.
- **Docs** — `landing/docs.html` is the public docs page.
- **CLI improvements** — `server/src/cli/setup.ts` and `server/src/cli.ts`.
- **Tool handlers** — each handler in `src/background/tool-handlers/` is isolated.
- **Platform support** — we're primarily macOS. Windows and Linux contributions welcome.

### Needs discussion first

Open an issue before working on:
- Service worker (`src/background/service-worker.js`)
- MCP bridge (`src/background/modules/mcp-bridge.js`)
- Managed API (`server/src/managed/api.ts`)
- Auth or credential handling
- New LLM provider integrations

These modules are tightly coupled and security-sensitive.

## Testing

```bash
# Server unit + HTTP tests (local, no Postgres needed)
cd server
node dist/managed/api.test.js
node dist/managed/api-http.test.js
node dist/managed/hardening.test.js
node dist/managed/e2e.test.js

# Integration tests (needs running server + Postgres)
TEST_API_KEY=hic_live_... node dist/managed/integration.test.js
```

## Database

Local Postgres runs in Docker on port 5433 (not 5432, to avoid conflicts with any system Postgres).

Schema is in `server/src/managed/schema.sql`. It's idempotent — safe to re-run. All statements use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN IF NOT EXISTS`.

To reset the database:
```bash
make clean   # removes Docker volume
make db      # starts fresh Postgres
make migrate # applies schema
```

## Deployment

Production runs on a DigitalOcean VPS with Neon Postgres. Schema migrations are manual:

```bash
# Apply schema to production Neon
psql "$NEON_DATABASE_URL" -f server/src/managed/schema.sql

# Deploy to VPS
ssh your-vps "cd /opt/hanzi && git pull && cd server && npm run build && pm2 restart hanzi"
```

Environment variables needed in production:
- `DATABASE_URL` — Neon Postgres connection string
- `BETTER_AUTH_SECRET` — random string, must be stable across restarts
- `BETTER_AUTH_URL` — `https://api.hanzilla.co`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — for sign-in
- `NODE_ENV=production`

Optional:
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_MANAGED_PRICE_ID` — for billing
- `VERTEX_SA_PATH` or `VERTEX_SA_JSON` — for managed LLM routing

## PR checklist

- [ ] Limited to one area (skill, test, CLI, tool handler, docs, or landing page)
- [ ] Tested locally (`make build` passes)
- [ ] No changes to security-sensitive modules without prior discussion
- [ ] Follows existing code style

## Questions?

[Discord](https://discord.gg/hahgu5hcA5) · [GitHub Issues](https://github.com/hanzili/hanzi-in-chrome/issues) · hanzili0217@gmail.com
