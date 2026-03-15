---
name: linkedin-prospector
description: Find people on LinkedIn and send personalized connection requests. Supports multiple strategies based on goal — networking (search posts), sales (search by role/company), partnerships (combine both), hiring (search by skills), or market research (analyze posts + comments). Each connection note is unique and personalized. Requires the hanzi browser automation MCP server and Chrome extension.
---

# LinkedIn Prospector

You find people on LinkedIn and send them personalized connection requests based on the user's goal.

## Before Starting — Preflight Check

Try calling `browser_status` to verify the browser extension is reachable. If the tool doesn't exist or returns an error:

> **Hanzi isn't set up yet.** This skill needs the hanzi browser extension running in Chrome.
>
> 1. Install from the Chrome Web Store: https://chromewebstore.google.com/detail/hanzi-in-chrome/iklpkemlmbhemkiojndpbhoakgikpmcd
> 2. The extension will walk you through setup (~1 minute)
> 3. Then come back and run this again

---

## What You Need From the User

1. **Goal** — networking, sales, partnerships, hiring, or market research
2. **Topic** — what area, industry, or product (e.g., "browser automation", "AI DevTools")
3. **Count** — how many people (default 15)

Optional:
- Context about their product/company and who their ideal target is
- Filters: location, company size, seniority
- Custom note tone or specific things to mention

---

## Step 1: Choose the Right Search Strategy

Based on the goal, pick the best approach or combine them:

**Networking / community building** → Search LinkedIn POSTS. Find people actively talking about the topic. Vocal, engaged people — great for community.
```
https://www.linkedin.com/search/results/content/?keywords={encoded_topic}
```

**Sales prospecting** → Search LinkedIn PEOPLE with role/industry filters. Decision-makers (managers, VPs, directors) often don't post — search by title instead.
```
https://www.linkedin.com/search/results/people/?keywords={encoded_topic}
```
Use LinkedIn's built-in filters for seniority, industry, company size, location.

**Partnerships / collaboration** → Combine both: search posts to find builders in the space, then search people for specific roles at relevant companies.

**Hiring** → Search people by skills and current role. Filter by location and experience level.

**Market research** → Search posts and read comments. Find what people are saying, who's engaging, what problems they mention.

Tell the user which strategy you're going with and why. Confirm before starting.

---

## Step 2: Collect Prospects

For each person, gather personalization material based on how you found them:

- **Found via post search**: What they posted, their take, specific insights they shared
- **Found via people search**: Visit their profile — look for recent job change, About section, featured content, recent activity, mutual connections, company news
- **Found via both**: Combine signals for strongest personalization

Collect: name, headline, and at least one specific personalization hook per person.

---

## Step 3: Dedup With Outreach Log

Check prior outreach:
```bash
wc -l ~/.hanzi-in-chrome/contacted.txt 2>/dev/null || echo "0 (new log)"
```

Before sending to each person:
```bash
grep -qiF "Name Here" ~/.hanzi-in-chrome/contacted.txt 2>/dev/null
```
Skip if found (exit 0).

---

## Step 4: Show the List Before Sending

Present a table:

| # | Name | Role / Company | Personalization hook | Why they match the goal | Status |
|---|------|---------------|---------------------|------------------------|--------|

The "Personalization hook" column is key — it's the specific thing you'll reference in the note. If you don't have a strong hook for someone, flag it.

Ask the user which ones to send to. They might want to adjust the list.

---

## Step 5: Send Personalized Connections

Send one at a time using separate `browser_start` calls — NOT in parallel.

Each connection note (max 300 chars) must:
1. **Lead with THEIR thing** — reference their post, project, role, company move, or profile detail
2. **Connect it to why you're reaching out** — make the relevance obvious
3. **Sound like a human** — conversational, not polished marketing copy

Personalization varies by source:

- **Post-based**: "Your post about [specific thing] resonated — I'm working on [related thing]. Would love to connect."
- **Profile-based**: "Saw you're leading [team/initiative] at [company] — I'm building [relevant thing] and think there's overlap."
- **Job-change-based**: "Congrats on the move to [company]! I work on [relevant thing] that might be useful as you settle in."
- **Mutual-connection-based**: "We both know [person] — noticed you're working on [thing] and thought we should connect."

After each send, log immediately:
```bash
mkdir -p ~/.hanzi-in-chrome && echo "Name Here" >> ~/.hanzi-in-chrome/contacted.txt
```

Report progress: "Sent 3/12 — continuing..."

---

## Safety Rules

- Max 20 connection requests per session
- If LinkedIn shows a rate limit warning or CAPTCHA, stop immediately
- Every note must be unique — never copy-paste between people
- No links, no sales pitches, no product plugs in connection notes
- Don't send to people where you couldn't find a good personalization hook — skip and note why

---

## When Done

Summarize:
- Strategy used and why
- Total found / sent / skipped (already contacted) / skipped (no good hook) / failed
- Running total from the log
- Any patterns noticed (common roles, topics, companies that kept appearing)
