---
name: competitor-researcher
description: Research SaaS and AI-tool competitors in a real browser. Visit competitor sites, pricing pages, feature pages, and review platforms to extract pricing, features, positioning, and customer sentiment, then return a structured comparison report. Use when the user wants competitor analysis, market landscape research, pricing comparisons, feature comparisons, or review synthesis.
---

# Competitor Researcher

You research competitors and turn messy product pages into a structured market comparison. This skill is read-only: observe, extract, compare, and report. Do not sign in, submit forms, or mutate any site state.

## Tool Selection Rule

- **Prefer existing tools first**: If a competitor page is public and renders well without a browser, use normal web fetches or other available tools first.
- **Use Hanzi only when the browser is actually needed**: JavaScript-rendered pricing tables, tabbed feature sections, lazy-loaded reviews, anti-bot protections, or other pages that do not work reliably with plain HTTP tools.
- **Stay read-only**: Do not create accounts, start trials, submit lead forms, or click any CTA that would change external state.

## Before Starting — Preflight Check

Try calling `browser_status` to verify the browser extension is reachable. If the tool doesn't exist or returns an error:

> **Hanzi isn't set up yet.** This skill needs the hanzi browser extension running in Chrome.
>
> 1. Install from the Chrome Web Store: https://chromewebstore.google.com/detail/hanzi-browse/iklpkemlmbhemkiojndpbhoakgikpmcd
> 2. The extension will walk you through setup (~1 minute)
> 3. Then come back and run this again

---

## What You Need From the User

Before opening a browser, confirm:

1. **Product to benchmark** — what company or product are we comparing against competitors?
2. **Competitors** — exact competitor names or URLs. If unknown, ask whether to discover likely competitors first.
3. **Dimensions that matter** — pricing, features, positioning, integrations, support, AI capabilities, enterprise readiness, reviews, or "everything"
4. **Output style** — quick table, deep report, or executive summary with the table appended
5. **Scope limits** — how many competitors to research and whether to include review sites like G2, Capterra, and Product Hunt

Optional:
- Region or market segment (SMB, enterprise, developer tools, agencies, healthcare, etc.)
- Which pricing plan to focus on if there are many
- Whether to include screenshots as evidence

If the request is underspecified, pause and confirm the scope before opening a browser.

---

## Safety: Keep It Observational

Competitor research should not create accounts or trigger outreach.

Before proceeding:

- Confirm the user wants **read-only research**
- Avoid sign-up, booking-demo, free-trial, or contact-sales flows
- Do not scrape private dashboards or gated customer areas
- If a site blocks access with a CAPTCHA, bot wall, or login wall, stop on that source and note the limitation

Safe actions:
- Reading landing pages, pricing pages, feature pages, help docs, changelogs, and public reviews
- Expanding tabs, accordions, or "show more" sections when needed to read public content

Unsafe actions:
- Submitting forms
- Starting trials
- Entering contact information
- Logging into accounts without explicit user approval

---

## Phase 1: Plan the Research

Start by restating the target:

```text
Product: {target product}
Competitors: {list}
Dimensions: {pricing, features, positioning, reviews, etc.}
Output: {table / deep report / summary}
Review sources: {G2 / Capterra / Product Hunt / none}
```

For each competitor, identify likely sources:

| Source Type | Typical Pages |
|-------------|---------------|
| Official site | home page, pricing, features, integrations, enterprise, docs |
| Review platforms | G2, Capterra, Product Hunt |
| Supporting evidence | blog, changelog, docs, comparison pages |

If the competitor list is not provided, discover a short list first by reading public comparison pages and review listings, then confirm with the user before continuing.

---

## Phase 2: Gather Official Product Data

For each competitor, collect the following from public product pages:

- **Pricing** — plan names, list prices, usage limits, free tier, free trial, enterprise/contact-sales positioning
- **Features** — core features, standout capabilities, integrations, AI features, compliance/security claims
- **Positioning** — hero headline, subheadline, target customer, strongest messaging angle
- **Social proof** — customer logos, testimonials, usage numbers, case studies, badges

Prefer plain fetches for simple pages. Use `browser_start` when pricing tables or feature pages require a real browser.

### Browser extraction prompt pattern

When Hanzi is needed, use a task like:

```text
Visit this competitor's public site and extract structured product information. Read the home page, pricing page, and feature page if available. Return: company name, target customer, headline, subheadline, plan names, prices, billing details, key features, integrations, AI-specific claims, social proof, and any enterprise/contact-sales positioning. Expand tabs or accordions if needed, but do not sign up or submit forms.
```

If a site has multiple pricing toggles or tabs:
- Read monthly and annual pricing when available
- Note which values are hidden behind "contact sales"
- Call out usage-based pricing separately from seat-based pricing

If `browser_start` times out:
- Call `browser_screenshot` to see where it got stuck
- Retry once with a tighter task focused on just the missing page
- If it still fails, record the limitation and move on

---

## Phase 3: Gather Review Sentiment

Review sites are often the reason a real browser helps. For each competitor, check whichever of these are available:

- **G2**
- **Capterra**
- **Product Hunt**

Extract:
- Average rating if visible
- Review count if visible
- Repeated positives
- Repeated complaints
- Notable buyer segments or use cases

Do not try to summarize every review. Instead, synthesize recurring themes.

### Review synthesis rules

- Use at least 3 review signals per competitor when available
- Separate **strengths** from **complaints**
- Prefer recent or clearly visible feedback over old buried content
- If review data is sparse, say so explicitly instead of guessing

---

## Phase 4: Compare and Normalize

Once extraction is complete, normalize competitors into the same categories so the output is easy to compare.

Recommended comparison dimensions:

| Dimension | What to capture |
|-----------|-----------------|
| Pricing model | free, free trial, seat-based, usage-based, enterprise-only |
| Entry price | cheapest visible paid plan |
| Best-fit customer | indie, SMB, mid-market, enterprise, developer teams |
| Core strength | what they emphasize most |
| Differentiators | what appears unique or especially strong |
| Weaknesses / gaps | what is absent, unclear, or criticized in reviews |
| Review sentiment | recurring praise and recurring complaints |

If the user asked for custom dimensions, include those too.

---

## Phase 5: Output the Research Report

Always produce two parts:

### 1. Structured comparison table

Use a table like this:

| Competitor | Entry Price | Pricing Model | Best For | Core Strength | Key Gaps | Review Sentiment |
|------------|-------------|---------------|----------|---------------|----------|------------------|
| ExampleCo | $29/mo | seat-based | SMB teams | strong workflow automation | weak reporting | praised for ease of use, criticized for pricing |

### 2. Positioning and market summary

After the table, summarize:

- How each competitor positions itself
- Which competitors compete most directly with the target product
- Where pricing clusters or diverges
- Which features are becoming table stakes
- What review themes repeat across the market
- What whitespace or differentiation opportunities appear

### Output template

```text
Competitor Research Report

Target product: {product}
Competitors researched: {N}
Sources used: official sites, pricing pages, feature pages, {review sites}

[comparison table]

Positioning differences
- Competitor A positions around ...
- Competitor B positions around ...

Market insights
- Pricing trend:
- Feature trend:
- Review pattern:
- Opportunity:

Limitations
- Competitor C blocked browser access on its pricing page
- Competitor D had no public review profile on G2/Capterra
```

If the user asked for a short answer, compress the summary but keep the table.

---

## Example Output

The following example shows how to transform the raw browser findings above into the final report format described in Phase 5.

### Competitor Research Report

Target product: browser agent / browser automation platform

Competitors researched: 5

Sources used: official sites, pricing pages or plans pages, Product Hunt review pages

| Competitor | Entry Price | Pricing Model | Best For | Core Strength | Key Gaps | Review Sentiment |
|------------|-------------|---------------|----------|---------------|----------|------------------|
| Browser Use | $75/mo | free + credits + usage-based + enterprise | teams that want cost-efficient browser-agent automation with stealth and high concurrency | browser-agent automation with detailed usage pricing and strong concurrency | pricing page is complex and mixes plan, credits, and per-step or per-token costs | praised for automation capabilities and dependable agent support; no repeated public complaints were visible |
| Skyvern | $29/mo | free + credits + seat-like tiers + enterprise | developers, ops teams, and regulated enterprise workflows | browser-workflow automation with clear concurrency and compliance-oriented tiers | fewer repeated public complaints were visible because Product Hunt sentiment is still sparse | praised for browser automation and complex workflow handling; only visible criticism was that the product is still early stage |
| Browserbase | $20/mo | free + monthly tiers + enterprise | solo builders, startups, and enterprise teams running cloud browsers for AI | cloud browser infrastructure that scales cleanly from builder to enterprise use | public feedback is strongly positive but still light on repeated negatives | praised for easy integration, scalable infrastructure, and simple AI-browser workflows; only isolated requests for more tutorials and customization were visible |
| browserless | $25/mo | free + annual tiers + usage overages + enterprise | teams running browser automation at scale with Playwright or Puppeteer | managed browser automation infrastructure with transparent unit-based pricing and compliance options | heavier plans get expensive quickly and public review volume is low | praised for reliability, Chrome compatibility, and rendering automation; no repeated public complaints were visible |
| Browser Cash | $0.09/hour | pure usage-based | AI builders and enterprises needing real-browser nodes and async automation | real-browser network for AI systems with usage-based pricing and low boot times | no public Product Hunt review sentiment was visible yet | no public review score or sentiment visible on Product Hunt yet |

#### Positioning differences

- Browser Use positions around making web automation easy and cost-efficient for browser agents.
- Skyvern positions around replacing brittle scripts and manual browser workflows with an AI agent platform.
- Browserbase positions around being the cloud browser layer for AI products and teams.
- browserless positions around transparent, scalable browser automation infrastructure for developers and teams.
- Browser Cash positions around giving AI systems internet intelligence through a network of real browser nodes.

#### Market insights

- Pricing trend: this market mixes flat monthly plans with strongly usage-based pricing, and several products make concurrency, credits, proxies, or token costs part of the core commercial model.
- Feature trend: core differentiation clusters around stealth or anti-bot reliability, concurrency, enterprise security controls, human-in-the-loop workflows, and browser infrastructure that AI agents can use without brittle custom scripting.
- Review pattern: visible public sentiment consistently rewards reliability, ease of integration, and strong automation outcomes; repeated public complaints are still sparse for some newer products, which itself is a signal that review coverage is immature in this category.
- Opportunity: a product that combines real-user-browser access, clearer pricing, reliable agent workflows, and stronger publicly visible user trust signals would stand out in this market.

#### Limitations

- This example report uses browser-agent-adjacent competitors that were validated through public pages and public review surfaces visible at the time of testing.
- Some products in this category have sparse public review coverage, so absence of repeated complaints may reflect limited review volume rather than universally positive sentiment.

---


## Example Validation

The following real-world validation focuses on a browser-agent-adjacent set that is closer to Hanzi's market.

### Browser-agent-adjacent validation set

### Validation BA1 — Browser Use pricing and positioning

**Source:** `https://browser-use.com/pricing`

Observed results:
- Positioning: `Easiest way to automate the web` and `Cheapest browser agent`
- Target customer: teams that need browser automation capacity and high concurrency
- Visible pricing:
  - Free: `$0/month`
  - Subscription: `$75/month` visible public plan, with additional usage-based costs and credits ranges shown in the pricing table
  - Enterprise: custom / contact sales

Additional notes:
- The page mixes flat plans, credit ranges, session pricing, token pricing, and other usage-based charges
- The page repeatedly emphasizes concurrency, stealth mode, and browser-agent economics

### Validation BA2 — Browser Use Product Hunt reviews

**Source:** `https://www.producthunt.com/products/browser-use/reviews`

Observed results:
- Visible score: `5.0/5`
- Review count: `13 visible reviews`
- Common positives:
  - strong automation capabilities
  - dependable AI agent support
- Common complaints:
  - no repeated complaints were visible on the current page

### Validation BA3 — Skyvern pricing and positioning

**Source:** `https://www.skyvern.com/pricing`

Observed results:
- Positioning: `Start free, scale as you grow`
- Target customer:
  - developers and engineers replacing brittle scripts
  - enterprise and ops teams automating browser workflows at scale
- Visible pricing:
  - Free: `$0/month`
  - Hobby: `$29/month`
  - Pro: `$149/month`
  - Enterprise: custom

Additional notes:
- Skyvern exposes credits, concurrency, CAPTCHA support, credentials handling, and enterprise compliance features as core pricing differentiators

### Validation BA4 — Skyvern Product Hunt reviews

**Source:** `https://www.producthunt.com/products/skyvern/reviews`

Observed results:
- Visible score: `5.0/5`
- Review count: `7 visible reviews`
- Common positives:
  - browser automation strength
  - complex workflow and job-application automation
  - reliable automation of manual or repetitive tasks
- Common complaints:
  - only one visible criticism described the product as early-stage; no repeated complaint pattern was visible

### Validation BA5 — Browserbase plans and positioning

**Source:** `https://docs.browserbase.com/account/plans`

Observed results:
- Positioning: plans that scale from solo builders to enterprise teams
- Target customer:
  - solo builders
  - startups
  - enterprise teams needing stronger security and compliance
- Visible pricing:
  - Free: `$0/month`
  - Developer: `$20/month`
  - Startup: `$99/month`
  - Scale: custom

### Validation BA6 — Browserbase Product Hunt reviews

**Source:** `https://www.producthunt.com/products/browserbase/reviews`

Observed results:
- Visible score: `5.0/5`
- Review count: `11 public reviews`
- Common positives:
  - simple and powerful browser automation for AI agents
  - easy integration
  - scalable infrastructure
- Common complaints:
  - isolated requests for more tutorials, better heavy-task performance, and more customization

### Validation BA7 — browserless pricing and positioning

**Source:** `https://www.browserless.io/pricing`

Observed results:
- Positioning: `Simple, Transparent Pricing` for browser automation at scale
- Target customer:
  - teams at different browser-automation scales
  - larger enterprises needing private deployments and compliance
- Visible pricing:
  - Free
  - Prototyping: `$25/month` billed annually
  - Starter: `$140/month` billed annually
  - Scale: `$350/month` billed annually
  - Enterprise: custom

Additional notes:
- The page explains browserless pricing mechanics in units, overages, proxy traffic, and CAPTCHA solves

### Validation BA8 — browserless Product Hunt reviews

**Source:** `https://www.producthunt.com/products/browserless/reviews`

Observed results:
- Visible score: `5.0/5`
- Review count: `2 public reviews`
- Common positives:
  - reliable automation for rendering workflows
  - strong Chrome compatibility and configurability
- Common complaints:
  - no repeated complaints were visible on the current page

### Validation BA9 — Browser Cash developer page

**Source:** `https://browser.cash/developers`

Observed results:
- Positioning: `Providing AI systems with internet intelligence`
- Target customer:
  - AI builders
  - enterprises
  - AI agents and services needing reliable web-based automation
- Visible pricing:
  - Browser as a Service: `$0.09/hour`
  - Browser Agents: `$0.5 per M input tokens` and `$2 per M output tokens`

Additional notes:
- The page emphasizes no commitments, no subscriptions, and usage-based billing only
- Product framing is centered on a decentralized network of real browser nodes

### Validation BA10 — Browser Cash Product Hunt reviews

**Source:** `https://www.producthunt.com/products/browser-cash/reviews`

Observed results:
- No public reviews were visible
- No visible review score, review count, repeated positives, or repeated complaints were available on the page

---

## Rules

- Confirm scope before researching
- Prefer non-browser reads first; use Hanzi when the browser adds real value
- Stay read-only at all times unless the user explicitly says otherwise
- Do not invent pricing, review counts, or features that were not observed
- Distinguish clearly between observed facts and your synthesis
- If data is missing, say "not publicly visible" instead of guessing
- Focus on SaaS and AI tools by default, but adapt if the user names another public product category
- If one source contradicts another, note the discrepancy instead of silently picking one
