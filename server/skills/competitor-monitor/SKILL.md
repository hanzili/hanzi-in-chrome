---
name: competitor-monitor
description: Monitor competitor websites for changes. Visit a list of URLs, extract pricing, features, positioning, and key content, compare against previous snapshots stored locally, and generate a change report summarizing what's different. Use when the user says "check competitors", "what changed on their site", "monitor these URLs", or wants periodic competitive intelligence. Requires the hanzi browser automation MCP server and Chrome extension.
category: marketing
---

# Competitor Monitor

You monitor competitor websites and report what changed. You visit each URL, extract the important content (pricing, features, positioning, messaging), compare it against the last saved snapshot, and produce a clear change report.

## Tool Selection Rule

- **Prefer existing tools first**: If a page is public and simple, try `WebFetch` or `curl` before opening a browser. Use Hanzi only when the page requires JavaScript rendering, authentication, or interactive elements (tabs, accordions, lazy-loaded sections).
- **Use filesystem tools** to read/write snapshots — never store snapshots in the browser.
- **If a site blocks or shows a CAPTCHA**, stop that URL and move to the next. Report the failure.

## Before Starting — Preflight Check

Try calling `browser_status` to verify the browser extension is reachable. If the tool doesn't exist or returns an error:

> **Hanzi isn't set up yet.** This skill needs the hanzi browser extension running in Chrome.
>
> 1. Install from the Chrome Web Store: https://chromewebstore.google.com/detail/hanzi-browse/iklpkemlmbhemkiojndpbhoakgikpmcd
> 2. The extension will walk you through setup (~1 minute)
> 3. Then come back and run this again

---

## What You Need From the User

1. **URLs** — list of competitor pages to monitor (pricing pages, feature pages, landing pages, etc.)
2. **Focus areas** (optional) — what to pay attention to: pricing, features, positioning, team size, integrations, messaging, or "everything"
3. **Label** (optional) — a name for this monitoring set (e.g., "competitor-pricing", "market-landscape"). Defaults to "default".

Optional:
- Specific sections or elements to watch (e.g., "only the pricing table", "the hero section tagline")
- Whether to take screenshots for visual comparison
- Authentication details if any pages require login

---

## Phase 1: Prepare the Monitoring Run

### 1a. Load Previous Snapshots

Snapshots are stored in `~/.hanzi-browse/competitor-monitor/{label}/`. Each URL gets a file named by its sanitized hostname + path.

```bash
mkdir -p ~/.hanzi-browse/competitor-monitor/{label}
ls ~/.hanzi-browse/competitor-monitor/{label}/ 2>/dev/null || echo "NO_PREVIOUS_SNAPSHOTS"
```

For each URL, check if a previous snapshot exists:
```bash
cat ~/.hanzi-browse/competitor-monitor/{label}/{sanitized_filename}.json 2>/dev/null || echo "NO_SNAPSHOT"
```

If no previous snapshots exist, this is a **baseline run** — you'll capture the initial state without generating a diff.

### 1b. Plan the Extraction

For each URL, determine what to extract based on the page type and user's focus areas:

| Page Type | What to Extract |
|-----------|----------------|
| **Pricing page** | Plan names, prices, billing periods, feature lists per tier, CTAs, free tier details, enterprise contact options |
| **Features page** | Feature names, descriptions, categories, "new" or "coming soon" badges, comparison tables |
| **Landing/home page** | Hero headline, subheadline, value propositions, social proof (logos, testimonials, stats), CTAs |
| **About/team page** | Team size, key hires, office locations, funding mentions |
| **Blog/changelog** | Latest 3-5 post titles, dates, and summaries |
| **Integrations page** | List of integrations, categories, "new" badges |
| **Docs/API page** | Navigation structure, new sections, deprecation notices |

Present the plan: "I'll visit these N URLs and extract [focus areas]. Previous snapshots: [found/not found]. Ready to proceed?"

**Wait for user confirmation before visiting any URLs.**

---

## Phase 2: Visit and Extract (browser via Hanzi)

Visit each URL using `browser_start`. Run up to 3 URLs **in parallel** — each gets its own browser window.

For each URL:

```
browser_start({
  task: "Visit this page and extract all [focus areas]. Read the full page content including any sections behind tabs, accordions, or 'show more' buttons. Return structured data with: page_title, extraction_date, and each content section with its heading and text.",
  url: "{competitor_url}",
  context: "Focus areas: {focus_areas}. Extract exact text — do not paraphrase. Include prices with currency symbols. Expand any collapsed sections."
})
```

After `browser_start` returns:
1. Parse the result to extract structured content
2. If the user requested screenshots, call `browser_screenshot` for each page
3. Call `browser_stop` with `remove: true` to clean up

### Extraction Format

Structure the extracted data consistently:

```json
{
  "url": "https://competitor.com/pricing",
  "extracted_at": "2026-04-02T10:30:00Z",
  "page_title": "Pricing - Competitor",
  "sections": [
    {
      "name": "Plans",
      "content": [
        {
          "plan": "Starter",
          "price": "$9/mo",
          "billing": "billed annually",
          "features": ["Feature A", "Feature B", "5 users"]
        }
      ]
    },
    {
      "name": "Hero",
      "headline": "The fastest way to do X",
      "subheadline": "Used by 10,000+ teams"
    }
  ]
}
```

### Error Handling

- **Page blocked / CAPTCHA**: Skip, note in report, move to next URL
- **Page not found (404)**: Record as "page removed" — this itself is a significant change
- **Timeout**: Call `browser_screenshot` to capture current state, then `browser_stop`. Retry once. If it fails again, skip.
- **Login required**: Stop and ask the user for credentials. Pass via `context` field, never in `task`.

---

## Phase 3: Compare Against Previous Snapshots (no browser)

For each URL, compare the new extraction against the stored snapshot.

### Diff Categories

Classify every change into one of these categories:

| Category | What it means | Priority |
|----------|--------------|----------|
| **Pricing change** | Price increase/decrease, new tier, removed tier, changed billing | HIGH |
| **Feature change** | New feature added, feature removed, feature renamed or moved between tiers | HIGH |
| **Positioning change** | Headline, tagline, or value prop rewritten | MEDIUM |
| **Social proof change** | New logos, updated stats, new testimonials | LOW |
| **Structural change** | New page sections, reorganized layout, new navigation items | LOW |
| **Content update** | Minor text edits, typo fixes, updated dates | LOW |
| **Page removed** | URL now returns 404 or redirects | HIGH |
| **New page** | First time monitoring this URL (baseline) | INFO |

### Comparison Rules

- Compare section by section, not character by character
- For pricing: flag exact dollar amounts, percentage changes, and tier restructuring
- For features: track additions, removals, and tier movements separately
- For text: ignore minor formatting changes (whitespace, punctuation). Flag substantive rewording.
- If a section existed before but is now missing, flag as removed
- If a new section appears, flag as added

---

## Phase 4: Save Updated Snapshots

After comparison, save the new extraction as the current snapshot:

```bash
mkdir -p ~/.hanzi-browse/competitor-monitor/{label}
```

Write the JSON snapshot file for each URL:
```bash
cat > ~/.hanzi-browse/competitor-monitor/{label}/{sanitized_filename}.json << 'SNAPSHOT_EOF'
{extracted_json_here}
SNAPSHOT_EOF
```

Also append to the monitoring log:
```bash
echo '{"url":"{url}","checked_at":"{timestamp}","changes_found":{count},"categories":["{cat1}","{cat2}"]}' >> ~/.hanzi-browse/competitor-monitor/{label}/monitor-log.jsonl
```

---

## Phase 5: Generate Change Report

### Baseline Run (no previous snapshots)

If this is the first run, present the captured state:

```
Competitor Monitor — Baseline Captured

Label: {label}
Date: {date}
URLs monitored: {N}

Competitor: {name or domain}
  URL: {url}
  Pricing: {summary of tiers and prices}
  Key features: {top features}
  Positioning: "{headline}" — {subheadline}

Competitor: {name or domain}
  ...

Snapshots saved to ~/.hanzi-browse/competitor-monitor/{label}/
Next run will compare against this baseline.
```

### Change Report (subsequent runs)

```
Competitor Monitor — Change Report

Label: {label}
Date: {date}
URLs monitored: {N}
URLs with changes: {N}
URLs unchanged: {N}
URLs failed: {N}

--- HIGH PRIORITY CHANGES ---

[Competitor Name] — {url}
  PRICING: Starter plan increased from $9/mo to $12/mo (+33%)
  PRICING: New "Enterprise" tier added at custom pricing
  FEATURE: "AI Assistant" added to Pro tier (was not listed before)

--- MEDIUM PRIORITY CHANGES ---

[Competitor Name] — {url}
  POSITIONING: Hero headline changed
    Was: "The simple way to manage projects"
    Now: "The AI-powered way to manage projects"

--- LOW PRIORITY CHANGES ---

[Competitor Name] — {url}
  SOCIAL PROOF: Customer count updated from "5,000+" to "10,000+"
  CONTENT: Footer copyright year updated to 2026

--- NO CHANGES ---

[Competitor Name] — {url}: No changes detected

--- FAILED ---

[Competitor Name] — {url}: Blocked by CAPTCHA
```

### Strategic Insights

After the change report, provide analysis:

1. **Pricing trends** — Are competitors raising or lowering prices? Adding tiers? Moving to usage-based?
2. **Feature signals** — What are they building? What features are moving down-market (from enterprise to lower tiers)?
3. **Positioning shifts** — How is their messaging evolving? Are they targeting a new audience?
4. **Competitive implications** — What do these changes mean for the user's product? Any threats or opportunities?
5. **Recommended actions** — Specific suggestions: "Consider matching their free tier offering", "Their new AI feature overlaps with your roadmap item X"

---

## Snapshot File Naming

Sanitize URLs to create filenames:
- Replace `https://` and `http://` with nothing
- Replace `/`, `?`, `&`, `=` with `_`
- Replace `.` with `_` (except file extensions)
- Truncate to 100 characters
- Example: `https://competitor.com/pricing?plan=all` becomes `competitor_com_pricing_plan_all`

---

## Rules

- Always confirm the URL list and focus areas with the user before visiting any pages
- Never modify competitor websites — read only
- Save snapshots after every run so the next run has a baseline
- Classify all changes by priority — don't bury pricing changes in a wall of minor edits
- If a URL requires authentication, ask the user — never guess credentials
- Max 20 URLs per session to avoid rate limiting and long execution times
- Run up to 3 browser visits in parallel for speed, but not more (avoids overwhelming the browser)
- If a competitor site blocks automated access, note it and suggest the user visit manually
- Keep snapshots as structured JSON, not raw HTML — this makes comparison reliable across minor layout changes
- Log every monitoring run to `monitor-log.jsonl` for trend tracking across sessions
