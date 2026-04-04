# Skill Testing Matrix

Manual test plan and automated test script for all Hanzi Browse skills.

## Prerequisites

- Chrome extension loaded and running in chrome://extensions
- Server built: `cd server && npm run build`
- WebSocket relay reachable (started automatically by CLI)
- For login-required skills: signed into the relevant platform in Chrome

## Testing Matrix

| Skill | Type | Needs Browser | Needs Login | Test Command | Expected Outcome |
|-------|------|:---:|:---:|---|---|
| `hanzi-browse` | Core | Yes | No | `start "Read the page title" --url https://example.com` | Returns page title "Example Domain" |
| `e2e-tester` | QA | Yes | No | `start "Verify the page loads and has a heading" --url https://example.com --skill e2e-tester` | Reports heading found, no errors |
| `a11y-auditor` | Audit | Yes | No | `start "Run an accessibility audit" --url https://example.com --skill a11y-auditor` | Returns WCAG findings (contrast, headings, landmarks) |
| `data-extractor` | Extraction | Yes | No | `start "Extract all links from this page as JSON" --url https://example.com --skill data-extractor` | Returns JSON array of links |
| `social-poster` | Posting | Yes | Yes (X/LinkedIn/Reddit) | `start "Draft a post about testing automation" --skill social-poster --context "Dry run, do not post"` | Drafts platform-adapted content, awaits approval |
| `linkedin-prospector` | Outreach | Yes | Yes (LinkedIn) | `start "Find 3 QA engineers in San Francisco" --url https://www.linkedin.com --skill linkedin-prospector` | Returns list of profiles with names and titles |
| `x-marketer` | Marketing | Yes | Yes (X/Twitter) | `start "Find 3 tweets about browser automation and suggest replies" --skill x-marketer --context "Product: Hanzi Browse, URL: https://browse.hanzilla.co"` | Returns tweets with suggested reply text |

## Manual Test Procedures

### 1. hanzi-browse (Core)

**Goal:** Verify the core browser automation pipeline works end-to-end.

1. Run: `node server/dist/cli.js start "Read the page title and the first paragraph" --url https://example.com`
2. Wait for completion (should take < 30 seconds)
3. Check status: `node server/dist/cli.js status <session_id> --json`

**Pass criteria:**
- [x] Session status is `complete`
- [x] Result contains "Example Domain"
- [x] At least 1 step was logged
- [x] No errors in session log

### 2. e2e-tester

**Goal:** Verify the E2E testing skill can navigate a page and report findings.

1. Run: `node server/dist/cli.js start "Test that the page loads correctly, has a heading, and the More Information link works" --url https://example.com --skill e2e-tester`
2. Wait for completion (should take < 60 seconds)

**Pass criteria:**
- [x] Session status is `complete`
- [x] Result mentions heading verification
- [x] Result mentions link navigation
- [x] No unhandled errors

### 3. a11y-auditor

**Goal:** Verify the accessibility audit skill can analyze a page.

1. Run: `node server/dist/cli.js start "Run an accessibility audit and report findings" --url https://example.com --skill a11y-auditor`
2. Wait for completion (should take < 90 seconds)

**Pass criteria:**
- [x] Session status is `complete`
- [x] Result includes WCAG-related findings (contrast, landmarks, headings, etc.)
- [x] Findings are structured (not just raw text)

### 4. data-extractor

**Goal:** Verify the data extraction skill can pull structured data from a page.

1. Run: `node server/dist/cli.js start "Extract all hyperlinks from this page as a JSON array with text and href" --url https://example.com --skill data-extractor`
2. Wait for completion (should take < 60 seconds)

**Pass criteria:**
- [x] Session status is `complete`
- [x] Result contains JSON or structured data
- [x] At least one link is extracted (e.g., "More information..." -> iana.org)

### 5. social-poster

**Goal:** Verify the social poster skill drafts content without actually posting.

1. Run: `node server/dist/cli.js start "Draft a LinkedIn post about browser automation for QA teams" --skill social-poster --context "Dry run only. Do NOT post anything. Just show me the draft."`
2. Wait for completion (should take < 60 seconds)

**Pass criteria:**
- [x] Session status is `complete`
- [x] Result contains a draft post
- [x] No actual post was made (dry run respected)

### 6. linkedin-prospector

**Goal:** Verify the LinkedIn prospector skill can search and find profiles.

**Prerequisite:** Signed into LinkedIn in Chrome.

1. Run: `node server/dist/cli.js start "Find 3 QA engineers in San Francisco. Do NOT send any connection requests." --url https://www.linkedin.com --skill linkedin-prospector`
2. Wait for completion (should take < 120 seconds)

**Pass criteria:**
- [x] Session status is `complete`
- [x] Result contains profile names and titles
- [x] No connection requests were sent (read-only test)

### 7. x-marketer

**Goal:** Verify the X marketer skill can find relevant conversations and suggest replies.

**Prerequisite:** Signed into X/Twitter in Chrome.

1. Run: `node server/dist/cli.js start "Find 3 tweets about browser automation and suggest helpful replies. Do NOT post anything." --skill x-marketer --context "Product: Hanzi Browse - browser automation for AI agents. URL: https://browse.hanzilla.co. Dry run only."`
2. Wait for completion (should take < 120 seconds)

**Pass criteria:**
- [x] Session status is `complete`
- [x] Result contains found tweets
- [x] Result contains suggested replies
- [x] No replies were actually posted (dry run respected)

## Pass/Fail Criteria Summary

A skill test **passes** if:
1. The CLI exits without crash
2. Session status reaches `complete` (not `error`)
3. The result contains expected content for that skill type
4. No unintended side effects occurred (no posts, no connection requests during dry runs)

A skill test **fails** if:
1. The CLI crashes or hangs past the timeout
2. Session status is `error`
3. The result is empty or irrelevant to the task
4. An unintended action was performed (posting, sending requests)

## Running the Automated Test Script

```bash
# Run all tests (requires browser + extension running)
./server/test/skills/test-skills.sh

# Run a specific skill test
./server/test/skills/test-skills.sh hanzi-browse

# Dry run (prints commands without executing)
./server/test/skills/test-skills.sh --dry-run

# Dry run a specific skill
./server/test/skills/test-skills.sh --dry-run e2e-tester
```
