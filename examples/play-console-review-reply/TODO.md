# Play Console Review Reply — Development Plan

## What this is
A free tool that fetches unanswered Google Play Store reviews and posts AI-drafted responses.
Powered by Hanzi Browse SDK — users see the SDK in action and become customers.

## Architecture
- **Browser Agent** (Gemini Flash via Hanzi Browse): navigates Play Console, fetches reviews, posts responses
- **Strategy AI** (Claude): categorizes reviews, drafts appropriate responses per review type
- **One browser session** per user, sequential posting (respect Play Console rate limits)
- Manual trigger only — user must have Chrome open with Play Console accessible

## Current state

### What exists
- [x] `server.js` — Express server with 3 API endpoints + `/api/mock-reviews`
- [x] `index.html` — 3-screen UI (setup → fetching → drafts), mock mode, embed widget
- [x] `package.json` — Minimal dependencies
- [x] embed.js widget wired up correctly (`HanziConnect.mount` with `apiUrl: location.origin`)
- [x] Mock flow tested end-to-end: fetch → draft (Claude) → approve → simulated post ✓
- [x] Strategy AI (Claude) correctly categorizes reviews and drafts responses ✓

### What's next

---

## Phase 1 — Real Play Console testing (P0)

Mock flow works. Now need to verify the browser task against real Play Console.

### 1a. Test Play Console navigation
- [ ] Manually verify: can browser agent navigate to Play Console, find an app, reach reviews?
- [ ] Identify the actual URL structure for reviews page
- [ ] Identify the "Reply" button selector and interaction pattern
- [ ] Document any quirks (async loading, pagination, review filters)

### 1b. Fix browser task prompts based on real behavior
- [ ] Refine `fetch-reviews` task prompt based on what Play Console actually looks like
- [ ] Test review extraction: does the agent return structured data we can parse?
- [ ] Refine `post-response` task prompt: does clicking Reply and typing work?
- [ ] Handle the case where Play Console has 2-step verification on first load

### 1c. End-to-end test
- [ ] Full flow: connect browser → fetch real reviews → draft → approve → post one response
- [ ] Verify posted response appears in Play Console

---

## Phase 2 — UI quality (P1)

x-marketing has a landing/hero screen, our tool goes straight to setup. Match that quality.

### 2a. Add landing/hero screen
- [ ] Hero headline + sub + "Try it free" CTA button
- [ ] Demo card showing a fake review + AI response (static, non-interactive)
- [ ] 3 feature bullets below demo
- [ ] Chrome-only warning (same check as x-marketing)

### 2b. Fix XSS vulnerabilities
- [ ] Add `esc()` function for HTML escaping
- [ ] Apply `esc()` everywhere user-provided data is rendered into innerHTML
  - reviewer names, review text, response text, app name

### 2c. Improve loading states
- [ ] Elapsed timer during browser fetch (same as x-marketing search timer)
- [ ] Per-step progress: "Opening Play Console... Found app... Loading reviews..."
- [ ] Cancel button during fetch

### 2d. Toast notifications
- [ ] Add toast system for transient messages
- [ ] Use toasts for: rate limit hit, browser disconnected, copy-to-clipboard

### 2e. Better draft card actions
- [ ] "Copy" button on each response (for manual paste if needed)
- [ ] Char count on response textarea (Play Console has ~350 char limit)
- [ ] "Regenerate" button per card (calls /api/draft-responses for just that one review)

### 2f. Post-posting state
- [ ] After all posted: success banner with count
- [ ] "Fetch more reviews" button to start another round

---

## Phase 3 — Reliability & error handling (P1)

### 3a. Error states (each should have a specific message + action)
- [ ] Browser not connected → show reconnect button
- [ ] Play Console not logged in → "Make sure you're signed into Play Console in Chrome"
- [ ] App not found → "We couldn't find [app name]. Try entering the package name instead"
- [ ] No unanswered reviews → "Your review inbox is clear!" with option to check again
- [ ] Post failed → mark card as failed, allow retry
- [ ] Rate limit hit → show daily limit, link to get own API key
- [ ] Network error → generic retry message

### 3b. State recovery
- [ ] If page refreshes mid-posting, restore drafts from localStorage with `posting → approved` reset
- [ ] If browser disconnects mid-post, pause and show reconnect prompt

### 3c. Play Console quirks
- [ ] Handle: "Sign in with Google" prompt if session expired
- [ ] Handle: multiple Google accounts in Chrome (agent may pick wrong one)
- [ ] Handle: Play Console showing "Something went wrong" (retry once)

---

## Phase 4 — Analytics & polish (P2)

### 4a. PostHog analytics (same setup as x-marketing)
- [ ] Add PostHog snippet to index.html
- [ ] Track: `tool_landing_viewed`, `tool_setup_started`, `reviews_fetched` (count), `responses_drafted` (count), `response_posted`

### 4b. Base path handling
- [ ] Add `const BASE = location.pathname.replace(/\/$/, '')` for Caddy deployment
- [ ] All API calls use `BASE + '/api/...'` pattern

### 4c. Reply dedup log
- [ ] Store posted review IDs in localStorage
- [ ] Skip already-replied reviews on next fetch

### 4d. README
- [ ] Architecture diagram (same format as x-marketing README)
- [ ] Setup instructions
- [ ] Required env vars
- [ ] Flow description
- [ ] Known limitations

---

## Testing plan

### Manual test checklist (run before any PR)

**Setup:**
- [ ] Page loads, embed widget appears
- [ ] Connect button works, session ID appears
- [ ] Form validation: submit without app name → error
- [ ] Form validation: submit without browser → error

**Fetch:**
- [ ] Browser navigates to Play Console (visible in Chrome)
- [ ] Agent finds the correct app by name
- [ ] Agent finds the correct app by package name
- [ ] Reviews are extracted and displayed (check names, ratings, text)
- [ ] "No reviews" case handled gracefully
- [ ] Cancel button stops the task

**Draft:**
- [ ] All reviews shown with AI responses
- [ ] Correct category tags (bug/feature/praise/complaint/question)
- [ ] Response text is editable
- [ ] Char count updates as you type
- [ ] Approve / skip / unapprove all work
- [ ] "Approve all" works
- [ ] localStorage persists drafts across refresh

**Post:**
- [ ] Browser navigates to correct review
- [ ] Response text is posted correctly
- [ ] Card updates to "Posted" state
- [ ] Failed post shows error state
- [ ] Rate limit respected (2s gap between posts)

**Error cases:**
- [ ] Browser disconnects mid-flow → graceful message
- [ ] Play Console session expired → helpful message
- [ ] App not found → helpful message

### Known limitations to document
- Browser must be open and logged into Play Console during the entire flow
- Play Console has ~350 char limit on responses
- Posting speed is limited to avoid triggering Play Console rate limits
- If you have multiple Google accounts, the agent may not pick the right one (mitigation: use package name)

---

## Future (not now)
- App Store Connect support (iOS reviews)
- Sentiment trend chart (are ratings improving?)
- Filter by rating (only reply to 1-2 stars)
- Template library for common response types
- Auto-detect app from connected browser session
