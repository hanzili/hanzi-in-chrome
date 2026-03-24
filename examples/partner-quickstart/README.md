# Hanzi Partner Quickstart

Minimal example showing how to embed Hanzi browser automation into your product.

**What this does:** pair a browser → run a task → show the result.

## Prerequisites

- Node.js 18+
- A Hanzi API key ([sign in](https://api.hanzilla.co/api/auth/sign-in/social) to your developer console and create one)
- The [Hanzi Chrome extension](https://chrome.google.com/webstore/detail/iklpkemlmbhemkiojndpbhoakgikpmcd) installed in the browser you want to control

## Setup

```bash
cd examples/partner-quickstart
npm install
HANZI_API_KEY=hic_live_... npm start
```

Open http://localhost:3000.

## How it works

1. **Generate pairing token** — your backend calls `POST /v1/browser-sessions/pair`
2. **User enters token** — they paste it in the Chrome extension (Settings → Managed → paste → Connect)
3. **Check sessions** — your backend calls `GET /v1/browser-sessions` to see connected browsers
4. **Run a task** — your backend calls `POST /v1/tasks` with a task description and session ID
5. **Show result** — poll `GET /v1/tasks/:id` until complete, then display the answer

## Code structure

One file: `server.js` — Express server with 3 API routes and an inline HTML frontend.

| Route | What it does |
|-------|-------------|
| `POST /api/pair` | Creates a pairing token via Hanzi API |
| `GET /api/sessions` | Lists connected browser sessions |
| `POST /api/task` | Runs a task and polls until complete |
| `GET /` | Serves the frontend |

## Environment variables

| Variable | Required | Default |
|----------|----------|---------|
| `HANZI_API_KEY` | Yes | — |
| `HANZI_API_URL` | No | `https://api.hanzilla.co` |
| `PORT` | No | `3000` |

## Next steps

- Replace the inline HTML with your own frontend
- Store browser session IDs per-user in your database
- Add error handling and reconnection logic
- See the [full API reference](https://browse.hanzilla.co/docs.html#build-with-hanzi)
