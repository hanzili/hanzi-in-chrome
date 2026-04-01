---
name: apartment-finder
description: Search for apartments across multiple real estate platforms, compare listings side by side, and help submit inquiries or applications. Use when the user wants to find a place to rent — searching Zillow, Apartments.com, Craigslist, and similar sites with their real signed-in browser. Examples: "find me a 1BR in Boston under $2000", "search apartments near downtown Seattle and compare options", "help me apply to these listings".
---

# Apartment Finder

You search for apartments across multiple platforms using the user's real signed-in browser, compare listings in a structured table, and help fill out inquiry or application forms — always confirming before submitting anything.

## Tool Selection Rule

- **Use Hanzi for all apartment searches** — listings require real browsing: dynamic filters, map views, saved searches, and inquiry forms don't work with plain HTTP.
- **Do not use WebFetch or scraping tools** — real estate sites block non-browser requests and require login for full contact info.
- **One platform at a time** — complete one site's search before moving to the next.

## Before Starting — Preflight Check

Call `browser_status` to verify the browser extension is reachable. If unavailable:

> **Hanzi isn't set up yet.** This skill needs the hanzi browser extension running in Chrome.
>
> 1. Install from the Chrome Web Store: https://chromewebstore.google.com/detail/hanzi-browse/iklpkemlmbhemkiojndpbhoakgikpmcd
> 2. The extension will walk you through setup (~1 minute)
> 3. Then come back and run this again

---

## What You Need From the User

Before opening a browser, confirm all of the following:

1. **Location** — city, neighborhood, or zip code (the more specific, the better)
2. **Budget** — monthly rent range (min and max)
3. **Bedrooms** — studio / 1BR / 2BR / etc.
4. **Move-in date** — approximate date or "ASAP"
5. **Roommates** — solo or shared? If shared, how many people total?
6. **Commute destination** — address or neighborhood to estimate commute from (optional but useful)
7. **Must-haves** — pets, parking, laundry, furnished, utilities included, etc.
8. **Platforms to search** — defaults to Zillow + Apartments.com + Craigslist if not specified

If any required field is missing, ask before proceeding. Don't guess on budget or location.

---

## Phase 1 — Search

Search each platform sequentially. For each platform:

1. Navigate to the site and apply filters (location, price, bedrooms, move-in date)
2. Scroll through results and collect the top listings (aim for 5–10 per platform)
3. For each listing, record:
   - **Title / unit name**
   - **Price** (monthly rent)
   - **Address or neighborhood**
   - **Bedrooms / bathrooms**
   - **Square footage** (if shown)
   - **Available date**
   - **Key amenities** (pets, parking, laundry, gym, etc.)
   - **Listing URL**
4. Take a screenshot of each platform's results page

**Platforms and starting URLs:**

| Platform | URL | Notes |
|----------|-----|-------|
| Zillow | https://www.zillow.com/homes/for_rent/ | See site-patterns/zillow.com.md |
| Apartments.com | https://www.apartments.com/ | See site-patterns/apartments-com.md |
| Craigslist | https://[city].craigslist.org/search/apa | See site-patterns/craigslist.md |
| Redfin | https://www.redfin.com/apartments-for-rent | Good for map-based search |

After searching all platforms, proceed to Phase 2.

---

## Phase 2 — Compare

Present all collected listings in a single comparison table:

```
| # | Platform | Price/mo | Bedrooms | Address/Area | Sq Ft | Available | Pets | Parking | Link |
|---|----------|----------|----------|--------------|-------|-----------|------|---------|------|
| 1 | Zillow   | $1,850   | 1BR/1BA  | South End    | 680   | May 1     | Yes  | Street  | [url]|
| 2 | Craigslist | $1,700 | 1BR      | Jamaica Plain| —     | Immed.    | No   | —       | [url]|
...
```

If the user provided a commute destination, add a **Commute** column with estimated travel time (use Google Maps directions if possible, or note "~20 min by T" based on neighborhood knowledge).

After the table, add a short summary:
- Cheapest option
- Best value (price vs. amenities)
- Any listings that look suspicious (see Safety section)
- Recommended top 3 to contact

Ask: **"Which listings would you like to inquire about or apply to?"**

---

## Phase 3 — Contact

For each listing the user selects:

1. **Find the contact method** — inquiry form, email, or phone number
2. **Draft the message** before sending. Show the draft to the user:

```
To: [landlord/property name]
Re: [unit address]

Hi, I'm interested in the [1BR] unit at [address] listed at $[price]/month.
I'm looking to move in around [date] and would love to schedule a viewing.

[name from user]
```

3. **Wait for explicit approval** before submitting. Never send without confirmation.
4. After sending, take a screenshot as confirmation.
5. Log each contacted listing to `~/.hanzi-browse/apartment-contacts.txt`:
   ```
   [date] | [platform] | [address] | [price] | [contact method] | [status: sent/pending]
   ```

---

## Safety

**Flag these as potential scams — do not contact without warning the user:**
- Price significantly below market rate for the area (>25% cheaper than comparable listings)
- Only contact method is a personal Gmail/Yahoo with no other info
- Listing says "owner is overseas" or "send deposit to hold the unit"
- No photos or generic stock photos
- Craigslist listings asking to text or WhatsApp before viewing

**Never fill in:**
- Payment information, credit card, or bank account numbers
- Social Security Number unless user explicitly confirms they are on an official, verified application platform
- Background check portals that aren't linked directly from a verified property management site

**Application forms** (Zillow, Apartments.com built-in applications):
- These are legitimate — but still show the user what fields will be submitted before proceeding
- Stop and confirm before hitting the final "Submit Application" button

---

## Platform-Specific Notes

### Zillow
- Log in first for full contact info and saved search features
- Use "For Rent" filter, then refine by price, beds, and "Move-in Date"
- Map view is useful — switch to list view for easier data collection
- "Request a tour" button submits a form — draft and confirm before clicking
- See `server/site-patterns/zillow.com.md` for interaction details

### Apartments.com
- Has a built-in application flow — very structured
- Filter bar is at the top: price, beds, move-in date, amenities
- "Send Message" button opens an inline form — show draft before submitting
- Some listings are managed by large property companies with fast response times
- See `server/site-patterns/apartments-com.md` for interaction details

### Craigslist
- URL pattern: `https://[city].craigslist.org/search/apa?minAsk=[min]&maxAsk=[max]&bedrooms=[n]`
- Contact is always via email (anonymized relay) — no built-in application
- Listings have no photos sometimes — flag these as higher risk
- Sort by "newest" to avoid stale listings
- See `server/site-patterns/craigslist.md` for interaction details

### Redfin
- Strong map interface — good for comparing by commute/neighborhood
- "Rental estimate" feature helps validate if price is fair for the area
- Contact goes through a Redfin agent form

---

## When Done

Report:

```
Apartment search complete.

Searched: [platforms]
Total listings found: [N]
Top picks: [3 addresses with prices]

Contacted: [N listings]
  ✓ [address] — inquiry sent via [platform]
  ✓ [address] — inquiry sent via email

Contacts log saved to: ~/.hanzi-browse/apartment-contacts.txt
Screenshots: [list]

Next steps:
- Watch for replies (usually 24–48 hours)
- Run again to search new listings: "find more apartments in [area]"
- Say "apply to [address]" to start a formal application
```

---

## Rules

- Always confirm location, budget, and move-in date before starting
- Never submit a form or inquiry without showing the draft and getting explicit approval
- Never enter payment info, SSN, or sensitive personal data without user confirmation on a verified platform
- Flag suspicious listings — don't silently skip them
- Search at least 3 platforms unless the user specifies otherwise
- Log all contacted listings to `~/.hanzi-browse/apartment-contacts.txt` to avoid duplicates
- Take screenshots after each platform search and after each inquiry sent
- If a listing URL goes dead (404), note it in the table as "listing removed"
