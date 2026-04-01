---
domain: craigslist.org
aliases: [Craigslist, craigslist]
updated: 2026-04-01
verified: false
---

## Platform traits
- City-specific subdomains: `[city].craigslist.org`
- Static HTML pages — very fast to load, no JavaScript rendering issues
- No login required to browse; contact is via anonymized email relay
- Listings are individual (landlords, roommates) not property management companies
- No built-in application — all contact happens via email
- Listings expire after 30–45 days; stale posts are common

## City subdomain examples
| City | URL |
|------|-----|
| Boston | https://boston.craigslist.org |
| Seattle | https://seattle.craigslist.org |
| New York | https://newyork.craigslist.org |
| San Francisco | https://sfbay.craigslist.org |
| Los Angeles | https://losangeles.craigslist.org |
| Chicago | https://chicago.craigslist.org |

## Navigating to apartment listings
URL pattern for filtered search:
```
https://[city].craigslist.org/search/apa?minAsk=[min]&maxAsk=[max]&bedrooms=[n]
```

Bedroom codes: `1` = 1BR, `2` = 2BR, `3` = 3BR, `0` = studio

Example — 1BR in Boston, $1500–$2200:
```
https://boston.craigslist.org/search/apa?minAsk=1500&maxAsk=2200&bedrooms=1
```

Sort by newest: append `&sort=date` to the URL.

## Reading search results
- Each result row shows: price, title, date posted, neighborhood tag
- Results load all at once — no pagination JS; scroll the page to see all
- Use `read_page` or `get_page_text` — both work well on Craigslist (static HTML)
- "pic" tag next to a listing means it has photos — prefer these

## Listing detail page
- Direct URL from search results
- Sections: title, price, listing body, contact info, map (if provided), photos
- Contact button: "reply" opens an email form with Craigslist's anonymized relay address
- Posted date and "updated" date are shown — flag listings older than 2 weeks as possibly stale
- Sometimes includes: move-in date, lease length, utilities info in the body text

## Sending an inquiry via Craigslist email relay
1. On the listing page, click the "reply" button
2. Craigslist shows options: "email", "phone" (if provided), "text"
3. Click "email" — this opens a mail client with the anonymized address pre-filled, or shows the address
4. **Compose a draft** and show to user before sending:
   ```
   Subject: Inquiry — [address/title from listing]

   Hi,

   I'm interested in your listing at $[price]/month.
   I'm looking to move in around [date] and would love to schedule a viewing.

   [name]
   [phone — optional]
   ```
5. Get user approval, then send via the user's email client
6. Note: reply goes to an anonymized `[random]@reply.craigslist.org` address — this is normal

## Scam detection — flag these immediately
Craigslist has a high rate of rental scams. Flag any listing that has:
- Price >25% below comparable listings in the same neighborhood
- Body says "owner is traveling", "overseas", or "missionary work"
- Asks to "text only" or communicate via WhatsApp/Telegram before viewing
- No photos, or photos that look like stock images (professional interiors, no personal items)
- Asks for deposit or first month's rent via Zelle/Venmo/wire before viewing
- Gmail or Yahoo email only (no property management contact)
- Address that doesn't match any real building (check on Google Maps)

When flagging: "This listing shows [specific red flag]. I recommend not contacting until you can verify the landlord owns this property."

## Known traps
- "Apartment" section (`/apa`) is different from "rooms & shares" (`/roo`) — search both if the user is open to roommates
- Some listings are from property management companies and redirect to external sites — note the redirect
- Phone numbers are sometimes in image form to avoid scraping — screenshot if visible
- Listings in popular cities fill up fast — sort by date and prioritize newest
- "Do NOT contact me with unsolicited services or offers" at the bottom is standard boilerplate — ignore it
