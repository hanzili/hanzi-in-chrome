# X Marketing Automation

Find relevant X/Twitter conversations and draft replies — powered by Hanzi Browse.

## Architecture

Two-agent design. The browser agent and the strategy AI have different jobs:

```
Browser Agent (Gemini Flash via Hanzi)     Strategy AI (Claude)
  │                                          │
  │ "Search X for these keywords"            │ "Here are the raw results.
  │  Browse, scroll, read, return answer.    │  Extract tweets. Draft replies."
  │                                          │  Smart analysis + structured output.
  ▼                                          ▼
  Task answer (plain text)  ──────────→   Tweets + draft replies
```

The browser agent returns a plain-text answer describing what it found. The strategy AI then extracts structured tweet data and drafts replies.

This pattern works because:
- Flash is good at browser interaction, returns natural-language summaries
- Claude is good at analysis and structured output, doesn't need a browser
- The task answer (`GET /v1/tasks/:id` → `answer` field) contains everything the browser saw

## Setup

```bash
cd examples/x-marketing
npm install
```

Required env vars:
```bash
HANZI_API_KEY=hic_live_...          # Browser automation (from dashboard)
ANTHROPIC_API_KEY=sk-ant-... or ccproxy  # Strategy AI
LLM_BASE_URL=http://127.0.0.1:8003/claude  # If using ccproxy
```

```bash
npm start
# Open http://localhost:3001
```

## Flow

1. **Describe your product** — name, URL (optional), description
2. **AI generates strategy** — keywords, audience, voice (Strategy AI)
3. **If URL provided** — browser reads your website for deeper analysis (Browser Agent)
4. **Review strategy** — edit keywords if needed
5. **Search X** — browser searches, scrolls, reads pages (Browser Agent)
6. **Extract + draft** — strategy AI reads browsing log, extracts tweets, drafts replies (Strategy AI)
7. **Review drafts** — approve, edit, or skip each reply
8. **Post** — browser posts approved replies one by one (Browser Agent)

## Key endpoints

| Method | Path | What it does | Agent |
|--------|------|-------------|-------|
| POST | /api/analyze | Generate marketing strategy | Strategy AI |
| POST | /api/read-url | Read a website via browser | Browser |
| POST | /api/search-one | Search one keyword on X | Browser |
| POST | /api/extract | Extract structured tweets from search summaries | Strategy AI |
| POST | /api/draft | Score tweets + draft replies | Strategy AI |
| POST | /api/post | Post one approved reply | Browser |

## Data

Product strategy and drafts are persisted in localStorage (browser). The server is stateless — all state lives in the client. Clear localStorage to reset.
