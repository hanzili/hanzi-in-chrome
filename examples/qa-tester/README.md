# QA Tester

A free QA testing tool that runs real-browser tests on any web app using Hanzi Browse.

Paste a URL, optionally describe what your app does, and the AI crawls the page to infer your app's structure before generating a tailored test plan. Each test case is then executed by Hanzi in a real Chrome browser — clicking, submitting forms, triggering errors — and the results are compiled into a bug report with screenshots, reproduction steps, and severity ratings.

## What It Does

- Crawls the target URL first to infer app type and page structure
- Generates a test plan tailored to the specific app (not generic)
- Executes each test case in a real paired browser
- Rates bug severity relative to what the app does (a broken checkout is Critical; a misaligned label is Low)
- Returns a structured report grouped by severity with screenshots and repro steps

## Architecture

Follows the same two-layer pattern as `examples/a11y-audit/`:

- The client owns UI state and drives the flow
- The server is stateless and provides API routes
- Browser AI (Hanzi) performs real-browser test execution
- Strategy AI (Claude) crawls the page, plans test cases, and compiles the final report

Main files:

- [server.js](./server.js)
- [index.html](./index.html)
- [package.json](./package.json)

## Requirements

- Node.js 18+
- A valid `HANZI_API_KEY`
- Hanzi Browse Chrome extension installed and paired

Optional (for LLM-backed planning and reporting):

- `ANTHROPIC_API_KEY`
- or `LLM_BASE_URL` and `LLM_MODEL`

## Environment Variables

Required:

```bash
export HANZI_API_KEY=hic_live_xxx
```

Optional:

```bash
export ANTHROPIC_API_KEY=sk-ant-xxx
export HANZI_API_URL=https://api.hanzilla.co
export LLM_BASE_URL=https://api.anthropic.com
export LLM_MODEL=claude-sonnet-4-6
export PORT=3001
```

## Install

```bash
cd examples/qa-tester
npm install
```

## Run

```bash
npm start
```

Then open:

```
http://localhost:3001
```

## User Flow

1. Enter the app URL and an optional description
2. Choose scope: Quick run (3 test cases) or Full run (5 test cases)
3. Pair a browser session
4. Watch real-time test progress
5. Review the bug report with severity groupings and screenshots

## Scope Modes

**Quick run**

- 3 test cases covering the core happy path
- Best for a fast pre-deploy sanity check

**Full run**

- 5 test cases including error states, edge cases, and responsive layout
- Better for more thorough coverage before a release

## API Routes

- `POST /api/plan` — crawls the page and generates a tailored test plan
- `POST /api/test-case` — runs one test case in the real browser
- `POST /api/report` — compiles all results into a final bug report
- `GET /api/sessions` — lists browser sessions
- `POST /api/pair` — creates a pairing URL

## Severity Scale

Severity is rated relative to the specific app, not in absolute terms:

| Level | Meaning |
|-------|---------|
| Critical | App crash, data loss, or completely broken core flow |
| High | Core flow broken but workaround exists, or significant data is wrong |
| Medium | Degraded UX, confusing state, non-obvious failure |
| Low | Cosmetic issue, minor inconsistency, polish gap |

## Notes

- The crawl-first approach (fetching the page HTML before planning) gives the strategy AI real context about app structure, improving test plan quality vs. planning from a URL alone.
- Severity calibration is relative — the same bug may be rated differently on a portfolio site vs. an e-commerce checkout.
- Coverage is limited to the selected scope. Common patterns (signup, forms, navigation, CRUD) are well covered; domain-specific business logic requires a more tailored description.
- Some findings may reflect limitations in how Hanzi reads page content (via accessibility tree and `read_page`) rather than real user-facing bugs. Coordinate-based interactions still work correctly.
- Some test cases involving complex interactions (double-click, viewport resizing, multi-step sequences) may time out or error depending on the paired browser session and network conditions.
