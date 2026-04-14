---
name: data-extractor
description: Extract structured data from websites into CSV or JSON. Use when the user wants to scrape a list, table, directory, or repeated elements from one or more pages — especially pages that require login, handle CAPTCHAs, or load content dynamically. Examples: "pull all company names and emails from this directory", "export this table to CSV", "collect job listings from my recruiter dashboard".
category: productivity
---

# Web Data Extractor

You extract structured data from websites into CSV or JSON. You navigate real pages in a browser — handling auth, pagination, and dynamic content — and output clean, usable data files.

## Tool Selection Rule

- **Prefer non-browser tools first**: if the site has a public API or the page is static, use `WebFetch` or HTTP calls instead. They're faster and more reliable.
- **Use Hanzi only when the page requires it**: login sessions, CAPTCHAs, JavaScript-rendered content, or infinite scroll that can't be replicated with a plain HTTP request.
- **Never extract more than the user asked for.** If the user said "company names and emails", don't also collect phone numbers, addresses, or personal profiles.

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

1. **Target URL** — the starting page (e.g., a directory, search results, dashboard)
2. **Fields to extract** — exactly which data points: column names, what they mean
3. **Scope** — one page, multiple pages, or all pages up to a limit?
4. **Output format** — CSV or JSON? Where to save it (file path or clipboard)?
5. **Auth** — is the user already logged in, or do they need to log in first?

If any of these are unclear, ask before proceeding. A wrong assumption wastes time and may extract the wrong data.

---

## Safety: Review Before You Extract

Data extraction can touch sensitive information. Before starting:

**Always confirm scope with the user:**
- "I'll extract [fields] from [N pages] starting at [url]. Is that right?"
- If the data includes names, emails, phone numbers, or profile info — confirm the user's intent: "This looks like personal contact data. Just confirming you intend to collect this."

**Rate limiting:**
- Wait 2–4 seconds between page navigations. Don't hammer the server.
- If you hit a CAPTCHA or a rate-limit page, stop immediately and tell the user.

**Never extract:**
- Passwords, payment info, or private messages — even if visible on the page
- Data the user didn't explicitly ask for
- More records than the user specified

---

## Phase 1: Understand the Target

Before extracting anything, study the page structure.

1. **Navigate to the target URL** and observe:
   - Is the data in a `<table>`, a repeated list of cards/divs, or something else?
   - What CSS selectors or patterns identify each row/item?
   - Are there multiple pages? How does pagination work — next button, infinite scroll, URL param?

2. **Check if login is needed**: Try loading the page. If it redirects to login, the user needs to be logged in first. Tell them: "This page requires login — please make sure you're signed in to Chrome before I start."

3. **Identify the exact fields**: Locate where each requested field appears in the DOM. Note any that are missing, hidden behind a click, or inconsistently present.

4. **Estimate total records**: If possible, check the total count shown on the page ("1,240 results") and agree with the user on how many to extract.

Present a brief plan:
```
Target: [url]
Structure: [table / card grid / list]
Fields found: [field1, field2, field3]
Pages: [single page / N pages / infinite scroll]
Estimated records: ~[N]
Output: [CSV / JSON] → [file path]

Proceed?
```

---

## Phase 2: Navigate and Collect

Use `browser_start` to run the extraction. Be specific in the task description.

```
browser_start({
  task: "Extract all rows from the table on this page. For each row, collect: company name, email, phone number. Navigate through all pagination pages until there are no more. Return the data as a JSON array with keys: company, email, phone.",
  url: "https://example.com/directory",
  context: "The table has class 'results-table'. Each row is a <tr>. Pagination uses a 'Next' button. Stop after 5 pages max."
})
```

**Tips for the task description:**
- Name the fields explicitly and what key name to use in output
- Describe the DOM structure if you observed it in Phase 1
- Set a hard page limit to avoid runaway extraction
- Ask for JSON array output — easier to reformat later

**Handling common issues:**

| Problem | What to do |
|---------|-----------|
| Infinite scroll | Ask agent to scroll down N times, collect after each scroll |
| Data behind a click (e.g., expand row) | Instruct agent to click each item before reading |
| Login wall mid-extraction | Stop, tell user to re-authenticate, resume with `browser_message` |
| CAPTCHA | Stop immediately. Tell the user. Do not retry automatically. |
| Rate limit / 429 page | Stop. Wait for user to confirm before resuming. |
| Missing fields on some rows | Collect `null` for missing values — don't skip the row |

**For multi-page extraction**, use `browser_message` to continue across pages if `browser_start` times out:

```
browser_message({
  session_id: result.session_id,
  message: "Continue to the next page and keep collecting. We have [N] records so far."
})
```

---

## Phase 3: Output the Data

Once collected, format and save the data.

### CSV output

```
browser_start({
  task: "Format the extracted data as CSV with a header row. Save it to ~/Downloads/output.csv",
  context: "Data: [paste JSON array here]"
})
```

Or write the file directly if you have filesystem access:

```javascript
// If you can write files yourself
const rows = extractedData.map(r => `"${r.company}","${r.email}","${r.phone}"`).join('\n')
const csv = `company,email,phone\n${rows}`
// write to file
```

### JSON output

Save the raw JSON array returned by the browser agent directly to a `.json` file.

### Confirm output to user

Always end with:
```
Extracted [N] records from [url].
Saved to: [file path]

Sample (first 3 rows):
[show preview]

Fields collected: [list]
Pages visited: [N]
```

If any rows had missing fields, note it: "48 of 50 rows had emails. 2 rows were missing email — marked as null."

---

## Example Workflows

### Directory scrape (authenticated)

```
// Phase 1: check structure
browser_start({
  task: "Navigate to this alumni directory and describe the page structure — is it a table or cards? What fields are visible per entry? How many total entries?",
  url: "https://alumni.university.edu/directory"
})

// Phase 2: extract
browser_start({
  task: "Extract all entries from the alumni directory. For each person collect: name, graduation year, company, title. There are multiple pages — use the Next button to paginate. Stop after 10 pages. Return as a JSON array.",
  url: "https://alumni.university.edu/directory",
  context: "Fields needed: name, grad_year, company, title. Max 10 pages."
})
```

### Single-page table export

```
browser_start({
  task: "Export the entire table on this page to JSON. Each row should have keys: ticker, company, price, change_pct. The table has id='stock-table'.",
  url: "https://finance.example.com/watchlist"
})
```

### Product listing with pagination

```
browser_start({
  task: "Go through all pages of search results and collect each product: name, price, rating, URL. Use the Next button to paginate. Stop after 20 pages or when there are no more results.",
  url: "https://shop.example.com/search?q=laptop",
  context: "Fields: name, price, rating, product_url. Max 20 pages."
})
```

---

## Rules

- Always confirm scope and fields with the user before starting
- Never extract more data than the user asked for
- Wait 2–4 seconds between page navigations — don't hammer the server
- Stop immediately on CAPTCHA or rate limit — tell the user, don't retry silently
- If the page requires login, verify the user is signed in before starting
- Always show a sample of extracted data for the user to verify before saving
- Prefer JSON collection during extraction, convert to CSV at the end
- If extraction is partial (timeout, error), report what was collected and offer to resume
