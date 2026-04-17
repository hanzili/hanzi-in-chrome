# X Marketing Tool — TODO

## What this is
A free tool that finds relevant X/Twitter conversations and drafts replies. Powered by Hanzi Browse SDK — users see the SDK in action and become customers.

## Architecture
- **Strategy AI** (Claude via ccproxy): analyzes product, extracts tweets from browsing data, drafts replies
- **Browser Agent** (Gemini Flash via Hanzi Browse): searches X, reads pages, posts replies
- **One task per keyword**, run in parallel (max 3 concurrent)
- Manual trigger only — no scheduling (can't guarantee user's browser is open)

## What works
- [x] Product setup form (name, URL, description)
- [x] Strategy AI generates keywords, audience, voice
- [x] Browser reads user's website for better strategy (if URL provided)
- [x] Parallel keyword search on X (one task per keyword)
- [x] Two-agent extraction: Flash browses → Claude extracts structured tweets
- [x] Draft replies with voice matching and reply types (helpful/mention/direct)
- [x] Approve / edit / skip drafts
- [x] Post approved replies via browser
- [x] localStorage persistence (survives refresh)
- [x] Proxy bypass (server strips proxy env vars)

## What needs fixing

### P0: SDK Branding
- [ ] "Powered by Hanzi Browse" footer with link (added, needs restart to verify)
- [ ] Setup page: explain "we use your real Chrome via Hanzi Browse SDK"
- [ ] During search: show "Hanzi Browse is searching X from your browser..."
- [ ] After results: "Found 6 tweets using Hanzi Browse — [learn how to build this →]"

### P0: Error Handling
- [ ] Show clear error messages instead of silently going back to strategy screen
- [ ] "Free tasks exhausted" — show credit count, link to add more
- [ ] "Browser disconnected" — show reconnect button
- [ ] "Search returned no tweets" — suggest different keywords
- [ ] Network/proxy errors — show what happened

### P1: Editable Keywords
- [ ] Strategy screen: keywords as editable chips (click X to remove)
- [ ] Text input to add new keywords
- [ ] Keywords persist in localStorage

### P1: Progress Visibility
- [ ] During search: show "Keyword 1/3: AI agent browser... done"
- [ ] Show task IDs for debugging (small, copyable)
- [ ] Show step count as it progresses

### P2: Polish
- [ ] Pairing explanation: "We need your Chrome to search X with your real session"
- [ ] Better empty states
- [ ] Cancel button during search
- [ ] Mobile responsive check
- [ ] Favicon

## Known Limitations
- **Browser must be open**: Can't schedule — user triggers manually
- **Tool results not stored**: `task_steps` doesn't save `read_page` output (issue #40), so we use Flash's text summary instead of raw DOM
- **Flash sometimes returns "Task completed."**: The browser agent occasionally doesn't summarize what it saw. Parallel tasks + retry mitigate this.
- **Proxy in China**: Server must strip proxy env vars or fetch to api.hanzilla.co hangs
- **20 free tasks/month**: Each keyword search = 1 task. 3 keywords = 3 tasks. Reading website = 1 task. Posting = 1 task per reply.

## Future (not now)
- Cloud browser (always-on Chrome on server) → enables scheduling
- Auth (email collection or Hanzi Browse login)
- Hosted backend (separate from core Hanzi Browse API)
- Engagement history stored in DB (not just in-memory)
- Voice profile auto-detection from user's X profile
- Analytics: which keywords/reply types get engagement
