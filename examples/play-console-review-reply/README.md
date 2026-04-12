# Play Console Review Reply — Free Tool by Hanzi Browse

Reply to your Google Play Store reviews automatically. AI reads your unanswered reviews, surfaces bugs and feature requests, drafts responses in your voice, and posts them from your Chrome.

---

## Screenshots

<img src="https://github.com/user-attachments/assets/f4c52acc-3850-416d-afa5-8edbbb697e2c" width="600" alt="Landing page" />

<img src="https://github.com/user-attachments/assets/632575c4-7ff2-4551-b5e7-66253c06018b" width="600" alt="Fetching reviews" />

<img src="https://github.com/user-attachments/assets/1f698ffe-8c07-47a8-bf22-b0a0c7be3428" width="600" alt="Review insights and draft cards" />

---

## What it does

**Review insights** — AI reads all your unanswered reviews and surfaces what matters: bugs to fix (with severity), feature requests, and prioritized action items. You see the full picture before reading a single review.

**Auto-drafted replies** — AI categorizes each review (bug report / feature request / praise / complaint / question) and writes a human-sounding response. You approve, edit, or skip each one. Your Chrome posts the approved responses directly to Play Console.

---

## Setup

### How it works

Two AI agents work in sequence:

- **Browser Agent** (Hanzi Browse) — controls your real Chrome. Navigates Play Console under your existing session, extracts unanswered reviews, and posts approved responses one at a time.
- **Strategy AI** (Claude via Anthropic API) — reads the fetched reviews, produces an insights summary (bugs, feature requests, action items), then drafts a reply for each review.

### Prerequisites

- [Hanzi Browse Chrome extension](https://chromewebstore.google.com/detail/hanzi-browse/iklpkemlmbhemkiojndpbhoakgikpmcd) installed and paired
- A Google Play developer account with at least one published app
- Node.js 18+

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HANZI_API_KEY` | Yes | From [api.hanzilla.co](https://api.hanzilla.co) |
| `ANTHROPIC_API_KEY` | Yes | For Strategy AI (review analysis and drafting) |
| `LLM_BASE_URL` | No | Override if using a proxy (default: `https://api.anthropic.com`) |
| `PORT` | No | Default: `3002` |

### Run

```bash
cd examples/play-console-review-reply
HANZI_API_KEY=hic_live_... ANTHROPIC_API_KEY=sk-... node server.js
```

Open [localhost:3002](http://localhost:3002).

### Test without a real app

Click **"Use mock data"** on the setup screen — runs the full UI flow (fetch → insights → draft → approve → simulated post) without connecting to Play Console.

---

## Flow

```
1. Connect browser    — Hanzi widget pairs your Chrome
2. Enter app details  — name, package name, description, tone
3. Fetch reviews      — Browser Agent navigates Play Console, extracts unanswered reviews
4. Review insights    — AI agent analyzes all reviews: bugs, feature requests, action items
5. Draft responses    — AI agent categorizes and drafts a reply for each review
6. Approve & post     — you approve/edit/skip; Browser Agent posts to Play Console
```

---

## Features

- **Review insights card** — avg rating, sentiment, urgent bugs with severity, feature requests, prioritized action items
- **Multi-account support** — detects multiple Google accounts, lets you choose which one has Play Console
- **Cancel mid-flight** — Stop Agent button cancels the browser task at any point
- **Dedup log** — remembers which reviews you've already replied to (localStorage)
- **Per-card actions** — Copy response, Regenerate, Retry on failed post
- **Char count** — Play Console has a ~350 char limit; each card shows live count
- **State recovery** — page refresh won't lose your drafts or get stuck in "posting" state

---

## Known limitations

- Browser must stay open and logged into Play Console during the entire flow
- Play Console has ~350 char limit on responses
- Posting is sequential (one at a time) to avoid Play Console rate limits
- Full testing requires a published app with real user reviews

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/fetch-reviews` | Browser Agent fetches unanswered reviews from Play Console |
| `POST` | `/api/review-insights` | AI agent analyzes reviews into insights and action items |
| `POST` | `/api/draft-responses` | AI agent categorizes reviews and drafts responses |
| `POST` | `/api/post-response` | Browser Agent posts one response to Play Console |
| `POST` | `/api/cancel-fetch` | Cancels the active browser task |
| `POST` | `/api/mock-reviews` | Returns mock reviews for UI testing |
| `GET`  | `/api/logs` | Returns in-memory session log |
