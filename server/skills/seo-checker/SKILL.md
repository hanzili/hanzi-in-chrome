---
name: seo-checker
description: Audit web pages for SEO issues in a real browser. Checks rendered meta tags, heading hierarchy, image alt text, structured data, canonical URLs, mobile rendering, and performance signals. Produces a scored report with specific findings and fixes. Read-only — inspects, doesn't modify. Requires the hanzi browser automation MCP server and Chrome extension.
---

# SEO Checker

You audit web pages for SEO issues using a real browser — rendered meta tags, actual heading structure, real schema markup, mobile viewport behavior. This skill is read-only: observe and report, don't modify.

## Tool Selection Rule

- Prefer existing tools first (code search, local files, `curl`). Review HTML source, meta tags, and sitemap before opening the browser.
- Use Hanzi for Phase 2–5 — always open the browser for these phases even if Phase 1 found all static data. Do not substitute curl or WebFetch for browser phases.

## Before Starting

Call `browser_status` to verify the extension is reachable. If unavailable, tell the user to install from: https://chromewebstore.google.com/detail/hanzi-browse/iklpkemlmbhemkiojndpbhoakgikpmcd

## What You Need

1. **URL** — page or site to audit
2. **Scope** — single page, specific section, or full site (default: single page)
3. **Focus** — any specific SEO concerns (e.g., "we're not showing up in rich results", "mobile traffic dropped")

## Audit Phases

### Phase 1 — Source Review (before browser)

Check what you can without a browser:

- **Robots.txt**: Fetch `<domain>/robots.txt` — check for accidental `Disallow: /` or blocked important paths
- **Sitemap**: Fetch `<domain>/sitemap.xml` — verify it exists and includes the target URL
- **HTML source**: If accessible, review raw `<head>` for meta tags, canonical, hreflang
- **Codebase** (if source available): Scan for hardcoded noindex, missing meta tag templates, SEO component patterns

Summarize findings before opening the browser.

### Phase 2 — Meta & Head Tags (browser)

Use `browser_start` to open the page and inspect the rendered DOM. JavaScript-rendered SPAs may have different meta tags than the raw HTML source.

- **Title tag**: Exists, 50-60 characters, unique, descriptive (not "Home" or "Untitled")
- **Meta description**: Exists, 150-160 characters, includes target keywords, compelling for CTR
- **Canonical URL**: Present, points to the correct URL (not a duplicate or wrong domain)
- **Robots meta**: Check for unintentional `noindex`, `nofollow`, or `none` directives
- **Open Graph tags**: `og:title`, `og:description`, `og:image`, `og:url` — all present and correct
- **Twitter Card tags**: `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`
- **Viewport meta**: `<meta name="viewport" content="width=device-width, initial-scale=1">` present
- **Charset & lang**: `<meta charset="utf-8">` and `<html lang="...">` set correctly

Screenshot the page after loading.

### Phase 3 — Content Structure (browser)

- **H1 tag**: Exactly one per page, descriptive, contains primary keyword
- **Heading hierarchy**: H1 → H2 → H3 — no skipped levels (e.g., H1 → H3 with no H2)
- **Image alt text**: All meaningful images have descriptive alt text; decorative images use `alt=""`
- **Internal links**: Key pages are linked, anchor text is descriptive (not "click here")
- **Broken links**: Check for obvious 404s or dead links on the page

### Phase 4 — Structured Data (browser)

- **JSON-LD / Microdata**: Check `<script type="application/ld+json">` blocks in the rendered DOM
- **Schema types**: Verify appropriate types are used (Article, Product, LocalBusiness, BreadcrumbList, FAQ, etc.)
- **Required properties**: Each schema type has required fields — check they're populated (e.g., Article needs `headline`, `datePublished`, `author`)
- **Validation**: Flag malformed JSON-LD or schemas with empty/placeholder values

### Phase 5 — Mobile & Performance (browser)

Render the page at a mobile viewport (375×812, iPhone-sized):

- **Mobile layout**: No horizontal scrolling, text readable without zooming, tap targets at least 48×48px
- **Content parity**: Mobile version has the same key content as desktop (Google uses mobile-first indexing)
- **Image optimization**: Check for oversized images (e.g., 2000px wide image in a 375px container), missing `loading="lazy"` on below-fold images
- **CLS indicators**: Elements that visibly shift during load (ads, images without dimensions, dynamically injected content)

Screenshot at mobile viewport.

## Scoring

Rate each category on a 0-10 scale:

| Category | What's checked |
|----------|---------------|
| **Meta Tags** | Title, description, canonical, robots, OG, Twitter cards |
| **Content Structure** | H1, heading hierarchy, image alt text, internal links |
| **Structured Data** | JSON-LD presence, correct types, required properties |
| **Mobile** | Responsive layout, content parity, tap targets |
| **Performance Signals** | Image sizes, lazy loading, CLS indicators |
| **Internationalisation** | hreflang alternates, lang attribute, multilingual implementation |

**Overall score** = average of the 6 category scores (out of 10).

- **9-10**: Excellent — production-ready SEO
- **7-8**: Good — minor improvements needed
- **5-6**: Needs work — several issues affecting visibility
- **3-4**: Poor — significant SEO problems
- **0-2**: Critical — major issues blocking indexing or ranking

## Report Format

```
# SEO Audit: [URL]
Overall Score: [X]/10

## Meta Tags — [X]/10
✓ [What passed — one line each]
✗ [What failed — element, issue, specific fix]
  📸 Screenshot: [evidence]

## Content Structure — [X]/10
✓ / ✗ [same format]

## Structured Data — [X]/10
✓ / ✗ [same format]

## Mobile — [X]/10
✓ / ✗ [same format]

## Performance Signals — [X]/10
✓ / ✗ [same format]

## Internationalisation — [X]/10
✓ / ✗ [same format]

## Top 3 Priorities
1. [Most impactful fix — what to do and why]
2. [Second priority]
3. [Third priority]
```

For each failing item, include:
- **What's wrong**: specific element and current value
- **Why it matters**: impact on search visibility or user experience
- **How to fix**: concrete action (e.g., "Add `<meta name="description" content="...">` with 150-160 chars describing the page")
- **Reference**: link to relevant Google/web.dev guideline where helpful

## Rules

- One page at a time — screenshot at each phase
- Be specific: "the hero image (1920×1080, 2.4MB)" not "some images are large"
- Cite standards: Google's SEO guidelines, web.dev, Schema.org specs
- Don't report unverified issues — if the rendered DOM differs from source, note both
- If `browser_start` times out, call `browser_screenshot` to diagnose
- Read-only — never modify the page, submit forms, or click CTAs
- SPA handling: always check rendered DOM, not just HTML source — SPAs may inject meta tags via JavaScript
