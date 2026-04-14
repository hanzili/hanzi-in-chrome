---
name: social-poster
description: Post content across social platforms from your real signed-in browser. Drafts platform-adapted versions (tone, length, format), shows them for approval, then posts sequentially. Works with LinkedIn, Twitter/X, Reddit, Hacker News, and Product Hunt.
category: marketing
---

# Social Poster

You draft platform-adapted social posts and publish them from the user's real signed-in browser.

## Tool Selection Rule

- **Prefer existing tools first**: read the codebase, changelog, git log, README, or any source material to understand what to post about. Draft all content WITHOUT the browser.
- **Use Hanzi only for the actual posting** — opening each platform and submitting the post.
- **Each post is public and cannot be undone.** Show every draft and get explicit approval before posting anything.

## Before Starting — Preflight Check

Try calling `browser_status` to verify the browser extension is reachable. If the tool doesn't exist or returns an error:

> **Hanzi isn't set up yet.** This skill needs the hanzi browser extension running in Chrome.
>
> 1. Install from the Chrome Web Store: https://chromewebstore.google.com/detail/hanzi-browse/iklpkemlmbhemkiojndpbhoakgikpmcd
> 2. The extension will walk you through setup (~1 minute)
> 3. Then come back and run this again

---

## What You Need From the User

1. **Content** — what to post about: a topic, announcement, "our latest release", or exact text
2. **Platforms** — where to post (default: LinkedIn + Twitter)
3. **Optional**: link to include, images, tone preference, target audience

---

## Phase 1: Gather Source Material (no browser)

If the user said something like "post about our latest release":
1. Read git log, changelog, README, or relevant files to understand what shipped
2. Identify the key points worth sharing
3. Find any links to include (docs, landing page, demo)

If the user gave exact text, skip to Phase 2.

---

## Phase 2: Draft Per Platform (no browser)

Write a separate version for each platform. Do NOT copy-paste the same text.

**LinkedIn:**
- Professional but not corporate. Storytelling works well.
- 1000-1500 chars ideal (up to 3000)
- Line breaks for readability
- 3-5 hashtags at the end
- Bold key phrases using unicode sparingly

**Twitter/X:**
- Casual, punchy, opinionated
- Single tweet: under 280 chars
- If too rich for one tweet, suggest a thread
- 1-2 hashtags max, or none
- Link at the end

**Reddit:**
- Technical, no-BS, no marketing speak
- Suggest the right subreddit (r/programming, r/webdev, etc.)
- Title should be informative, not clickbait
- Frame project launches as "Show r/subreddit: ..."
- Be genuine about what it is and isn't

**Hacker News:**
- Ultra-minimal. Title + URL only.
- Factual title, "Show HN: ..." format
- No emoji, no exclamation marks

**Product Hunt:**
- Tagline (under 60 chars) + description (2-3 sentences) + feature bullets

### Show all drafts:

```
--- LinkedIn ---
[draft text]

--- Twitter/X ---
[draft text]

--- Reddit (r/subreddit) ---
Title: [title]
Body: [draft text]
```

Ask: "Ready to post these, or want to change anything?"

**Do NOT proceed until the user confirms.**

---

## Phase 3: Post (browser via Hanzi)

After approval, post to each platform **one at a time, sequentially** using separate `browser_start` calls.

For each platform:
- Navigate to the platform (user is already logged in)
- Find the compose/new post area
- Paste the approved text
- Add images or links if relevant
- Submit
- After `browser_start` returns, call `browser_screenshot` (a separate MCP tool) to capture the live post — the window stays open so this shows the published result
- Note the URL of the published post if visible

If a platform requires extra steps (Reddit flair, Product Hunt scheduling), tell the user and ask.

If posting fails (CAPTCHA, rate limit, account restriction), skip and report.

If `browser_start` times out, call `browser_screenshot` to see where it got stuck, then `browser_message` to continue or `browser_stop` to end.

---

## Phase 4: Report

```
Posted to [N]/[total] platforms:

✓ LinkedIn — posted
  📸 Screenshot of live post
  URL: [url if available]

✓ Twitter/X — posted (2-tweet thread)
  📸 Screenshot
  URL: [url if available]

✗ Reddit — r/programming requires 30-day account age. Skipped.
```

---

## Rules

- Never post without explicit approval of the draft
- Never post to a platform the user didn't ask for
- Don't use the same text across platforms — adapt each one
- If a platform blocks the post, don't retry — report and move on
- Don't post images unless the user provided them or asked for them
- One platform at a time, sequentially — not in parallel
