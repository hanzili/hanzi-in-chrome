# MediAssist — AI Medical Assistant Demo

Example app showing how to embed Hanzi Browse browser automation in a medical product. A doctor opens their EHR (Electronic Health Record) in Chrome, pairs their browser, then asks questions about the patient chart through a chat interface.

This demonstrates the [iAvicenne](https://iavicenne.com) use case: AI assistants that read real clinical data from any EHR system through the browser.

## Prerequisites

- Node.js 18+
- A Hanzi Browse API key ([sign in](https://api.hanzilla.co/api/auth/sign-in/social) to your developer console and create one)
- The [Hanzi Browse Chrome extension](https://chrome.google.com/webstore/detail/iklpkemlmbhemkiojndpbhoakgikpmcd) installed

## Setup

```bash
cd examples/partner-quickstart
npm install
HANZI_API_KEY=hic_live_... npm start
```

Open http://localhost:3000.

## How it works

1. **Open a patient chart** — the demo guides you to [OpenEMR](https://demo.openemr.io/openemr/index.php) (login: physician / physician), a free open-source EHR with sample patient data
2. **Connect your browser** — click "Connect browser", then click the pairing link
3. **Ask a question** — "What medications is the patient on?"
4. **Hanzi Browse reads the EHR page** — the AI reads everything visible in the chart
5. **Answer appears in chat** — clear, concise medical answer based on the chart

Any EHR that runs as a web app works — OpenEMR is just for the demo.

## Code structure

One file: `server.js` — Express server with 3 API routes and an inline HTML frontend.

| Route | What it does |
|-------|-------------|
| `POST /api/pair` | Creates a pairing token via Hanzi Browse API |
| `GET /api/sessions` | Lists connected browser sessions |
| `POST /api/task` | Sends a chart-reading task, polls until complete |
| `GET /` | Serves the MediAssist UI |

## Environment variables

| Variable | Required | Default |
|----------|----------|---------|
| `HANZI_API_KEY` | Yes | — |
| `HANZI_API_URL` | No | `https://api.hanzilla.co` |
| `PORT` | No | `3000` |

## Adapting for your product

- Replace the medical theme with your own domain
- Change the task prompt in `askQuestion()` to match what you need read from the browser
- Store browser session IDs per-user in your database
- See the [full API reference](https://browse.hanzilla.co/docs.html#build-with-hanzi)
