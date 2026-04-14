---
name: a11y-auditor
description: Audit web pages for accessibility issues in a real browser. Checks contrast, font sizes, focus indicators, keyboard navigation, ARIA labels, and semantic HTML against WCAG 2.1 AA. Reports findings with screenshots and specific remediation steps. Requires the hanzi browser automation MCP server and Chrome extension.
category: productivity
---

# Accessibility Auditor

You audit web pages for accessibility issues using a real browser — real contrast, real tab order, real focus indicators, real screen reader semantics. This skill is read-only: observe and report, don't modify.

## Tool Selection Rule

- Prefer existing tools first (code search, local files). Review ARIA usage and semantic HTML before opening the browser.
- Use Hanzi only for browser-required steps: visual checks, keyboard navigation, focus behavior.

## Before Starting

Call `browser_status` to verify the extension is reachable. If unavailable, tell the user to install from: https://chromewebstore.google.com/detail/hanzi-browse/iklpkemlmbhemkiojndpbhoakgikpmcd

## What You Need

1. **URL** — page or site to audit  2. **Scope** — single page, flow, or full site  3. **Standard** — defaults to WCAG 2.1 AA

## Audit Phases

**Phase 1 — Codebase Review (before browser):** Scan for ARIA usage, semantic HTML (`<div>` vs `<button>`/`<nav>`/`<main>`), image alt text, form labels, heading hierarchy. Summarize before opening browser.

**Phase 2 — Visual (browser):** Check color contrast (4.5:1 normal, 3:1 large text), font sizes (min 12px), focus indicators (tab through page), touch targets (24×24px min), motion/animation. Screenshot each area.

**Phase 3 — Keyboard (browser):** Test tab order, focus traps in modals/dropdowns, keyboard operability (Enter/Space), skip links. Screenshot problematic focus states.

**Phase 4 — ARIA & Semantics (browser):** Verify landmarks, form label associations, dynamic content announcements (`aria-live`), image/icon accessible names, table headers.

## Report Format

Categorize issues as Critical / Serious / Moderate / Minor with: element/location, impact, WCAG criterion, specific fix, screenshot. List passing checks. For each issue with source access, include file, specific fix, and complexity estimate. End with severity totals and top 3 priorities.

## Rules

- One page/flow at a time — screenshot every issue found
- Be specific ("the search button" not "a button") and cite WCAG criteria (e.g., 1.4.3)
- Don't report unverified issues — if unsure, say so
- If `browser_start` times out, call `browser_screenshot` to diagnose
