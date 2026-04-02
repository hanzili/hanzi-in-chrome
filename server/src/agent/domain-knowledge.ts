/**
 * Domain-specific knowledge for the server-side agent loop.
 * Matches the extension's domain-skills.js but only includes domains
 * relevant to managed/API tasks.
 */

interface DomainEntry {
  domain: string;
  skill: string;
}

const DOMAIN_KNOWLEDGE: DomainEntry[] = [
  {
    domain: "x.com",
    skill: `X/Twitter — verified patterns (updated 2026-03-30)

## Reading pages (CRITICAL)
- X loads content asynchronously — page looks empty for 3-5 seconds after navigation.
- read_page often returns ONLY "To view keyboard shortcuts" — tweets haven't loaded yet.
- DO NOT re-navigate to the same URL. That resets loading and makes it worse.
- Instead: wait 5 seconds, then use get_page_text — it reads visible text and is more reliable.
- If get_page_text returns nothing, scroll down once and try again.

## Search
- URL: x.com/search?q={encoded_query}&src=typed_query&f=live
- After navigating, wait 5 seconds, then get_page_text (NOT read_page).
- Scroll down once to load more tweets, then get_page_text again.
- Tweet URLs in page text follow pattern: /status/{id}

## Text input (CRITICAL — Draft.js)
- form_input DOES NOT WORK — Draft.js ignores programmatic input.
- computer type action GARBLES TEXT.
- ONLY RELIABLE METHOD — use javascript_tool:
  document.querySelector('[data-testid="tweetTextarea_0"]').focus();
  document.execCommand('insertText', false, 'your reply text here');
- Always verify text appeared by reading after insertion.

## Replying to a tweet
1. Navigate to tweet URL (x.com/{handle}/status/{id})
2. Wait 3 seconds, read the page
3. Click the reply/comment icon (speech bubble) in the action bar
4. Use javascript_tool to insert text (see above)
5. Verify text appeared, then click blue "Reply" button
6. Wait 2 seconds to confirm reply posted

## Known traps
- DO NOT scroll looking for "Post your reply" — reply box appears after clicking comment icon
- x.com/compose/post may open — that's fine, type and click Reply there
- "Leave site?" dialog — ALWAYS click Cancel, finish posting first
- Reply button is disabled until text is entered — verify first
- Space replies 15+ seconds apart (rate limiting)
- NEVER navigate to the same URL you're already on`,
  },
];

/**
 * Look up domain knowledge for a URL.
 * Returns the first matching entry, or null.
 */
export function getDomainSkill(url: string): DomainEntry | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return DOMAIN_KNOWLEDGE.find(
      (d) => hostname === d.domain || hostname.endsWith("." + d.domain)
    ) || null;
  } catch {
    // URL might not be a full URL — try matching as a bare domain
    const lower = url.toLowerCase();
    return DOMAIN_KNOWLEDGE.find(
      (d) => lower.includes(d.domain)
    ) || null;
  }
}
