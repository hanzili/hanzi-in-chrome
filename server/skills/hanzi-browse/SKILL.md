---
name: hanzi-browse
description: Use when a task requires interacting with a real browser — clicking, typing, filling forms, reading authenticated pages, posting content, or testing web apps. Also use when the user says "open", "go to", "check this site", "log in to", "post on", or needs their real cookies and sessions.
category: core
---

# Hanzi Browse

Give your AI agent a real browser. Hanzi controls the user's actual Chrome with their existing logins, cookies, and sessions — not a headless sandbox.

## When to Use

- **Browser-required tasks**: click buttons, fill forms, submit data, navigate pages
- **Authenticated access**: read pages that need login (email, dashboards, admin panels, social feeds)
- **Visual verification**: check what a page actually looks like, take screenshots
- **Real-world posting**: publish to LinkedIn, Twitter/X, Reddit from the user's signed-in account
- **E2E testing**: test a web app in a real browser on localhost or staging

## When NOT to Use

- Reading public pages (use `WebFetch` or `curl` instead)
- API calls (use `fetch` or HTTP tools)
- File operations (use filesystem tools)
- **Services with dedicated MCP tools** (Gmail, Calendar, Notion, Stripe) — use those tools instead, they're faster and more reliable
- Anything that doesn't need a rendered browser

## Tool Selection Rule

**Prefer non-browser tools first.** Check if a dedicated MCP tool exists for the service (Gmail, Calendar, Notion, etc.) — use that instead. Gather all context you can (code search, git log, file reads, API calls) BEFORE opening the browser. Use Hanzi only for steps that genuinely require a rendered page.

## Setup

If `browser_status` returns an error or the tool doesn't exist:

> **Hanzi Browse isn't set up yet.**
>
> Run: `npx hanzi-browse setup`
>
> This installs the Chrome extension and adds the MCP server to your agent (~1 minute).

## MCP Tools

### `browser_start`

Start a task. An autonomous agent navigates, clicks, types, and fills forms. Blocks until complete, waiting for input, or timeout (5 min).

```
browser_start({
  task: "Go to LinkedIn and send a connection request to Jane Doe at Acme Corp",
  url: "https://linkedin.com",
  context: "Connection note: Hi Jane, loved your post about AI agents. Would love to connect."
})
```

**Returns:** `{ session_id, status, result }`

| `status` | Meaning | What to do |
|-----------|---------|------------|
| `"completed"` | Task finished successfully | Read `result` for the answer |
| `"waiting"` | Agent needs input or clarification | Send `browser_message` with the answer |
| `"error"` | Something went wrong | Call `browser_screenshot`, then retry or adjust |
| `"timeout"` | Hit 5-minute limit | Call `browser_message` to continue, or `browser_stop` |

**Tips:**
- `task` — be specific: include the website, the goal, and details
- `url` — starting page (optional, agent can navigate itself)
- `context` — everything the agent needs: form values, text to paste, tone, credentials, choices
- You can run multiple `browser_start` calls in parallel — each gets its own window
- `session_id` is returned here — use it for all follow-up calls

### `browser_message`

Send a follow-up to a running or paused session.

```
browser_message({
  session_id: "abc123",
  message: "Now also check the Settings page"
})
```

Use when:
- The agent asked a question and you have the answer
- You want the agent to do more in the same browser window
- You need to provide additional context mid-task

### `browser_status`

Check session status. Returns session ID, status, task description, and last 5 steps.

```
browser_status()                           // all sessions
browser_status({ session_id: "abc123" })   // specific session
```

### `browser_stop`

Stop a session. Browser window stays open for review unless `remove: true`.

```
browser_stop({ session_id: "abc123" })                // stop, keep window
browser_stop({ session_id: "abc123", remove: true })   // stop + close window
```

### `browser_screenshot`

Capture current page as PNG. Useful when a task errors or times out — see what the agent was looking at.

```
browser_screenshot({ session_id: "abc123" })
```

## Patterns

### Multi-step workflow

```
// Step 1: Research
const result = browser_start({
  task: "Find the top 3 AI startups hiring in SF on LinkedIn Jobs",
  url: "https://linkedin.com/jobs"
})

// Step 2: Follow up in same session
browser_message({
  session_id: result.session_id,
  message: "Now save each job to my 'AI Jobs' collection"
})
```

### Parallel tasks

```
// These run simultaneously in separate browser windows
browser_start({ task: "Post announcement on LinkedIn", context: announcement })
browser_start({ task: "Post announcement on Twitter", context: announcement })
browser_start({ task: "Post announcement on Reddit r/programming", context: announcement })
```

### Error recovery

```
const result = browser_start({ task: "Fill out the application form", ... })

if (result.status === "error") {
  // See what went wrong
  const screenshot = browser_screenshot({ session_id: result.session_id })
  // Try again with more context
  browser_message({
    session_id: result.session_id,
    message: "The form has a CAPTCHA. Please wait for me to solve it, then continue."
  })
}
```

## Safety

- **Production URLs**: If a task will create real data (signups, posts, orders), confirm with the user first
- **Credentials in context**: Pass credentials via the `context` field, not in `task`
- **Public actions**: Posts, messages, and form submissions are real and visible. Always show the user what you'll post before doing it
- **Rate limits**: Social platforms may rate-limit. If the agent reports a CAPTCHA or block, stop and tell the user

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using browser to read public pages | Use `WebFetch` or `curl` — faster, no browser needed |
| Vague task descriptions | Be specific: "Go to X, click Y, fill Z with these values" |
| Not passing context | Put form values, text to paste, and preferences in `context` |
| Running sequentially when parallel works | Multiple `browser_start` calls run in separate windows |
| Not checking screenshots on error | Always call `browser_screenshot` when a task fails |

## Workflow Skills

Hanzi Browse also ships workflow skills for common tasks:

- **e2e-tester** — Test web apps like a QA person with real browser interactions
- **social-poster** — Draft and post content across LinkedIn, Twitter/X, Reddit
- **linkedin-prospector** — Find and connect with prospects on LinkedIn
- **a11y-auditor** — Run accessibility audits in a real browser
- **x-marketer** — Twitter/X marketing workflows

Install workflow skills from: `github.com/hanzili/hanzi-browse/tree/main/server/skills`
