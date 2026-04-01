---
domain: zillow.com
aliases: [Zillow]
updated: 2026-04-01
verified: false
---

## Platform traits
- React SPA — content loads asynchronously after navigation
- Requires login to see full landlord contact info on many listings
- Two views: map view and list view — list view is more reliable for data extraction
- Search state is encoded in the URL (filters, location, sort)
- Listings may show "Zestimate" rent estimate — useful for price validation

## Navigating to rental search
- Direct URL for rentals: `https://www.zillow.com/[city]-[state]/rentals/`
- Examples:
  - Boston: `https://www.zillow.com/boston-ma/rentals/`
  - Seattle: `https://www.zillow.com/seattle-wa/rentals/`
- After navigating, wait 3–5 seconds for listings to load
- Use `get_page_text` instead of `read_page` — more reliable for listing content

## Applying filters
Filter bar is at the top of the page. Key filters:
- **Price**: "Price" dropdown → set min/max monthly rent
- **Bedrooms**: "Beds & Baths" dropdown → select bedroom count
- **Home type**: make sure "Apartments" and "Condos/Co-ops" are checked
- **More filters**: additional options (pets, laundry, parking, move-in date)
- Each filter change triggers a page reload — wait 3 seconds before reading again

## Reading listing cards
Each listing card in list view contains:
- Price (bold, top-left of card)
- Address
- Bed/bath/sqft summary line
- Availability date (if shown)
- Thumbnail photo
- "Request a tour" button

To get full details, click a listing card to open the detail page.

## Listing detail page
- Full address, price, and availability at the top
- Photos gallery — scroll down for full amenity list
- "Contact" or "Request a tour" button on the right panel
- **Contact info**: only shown when logged in; may be a form or a phone number
- Amenities section lists: pets, parking, laundry, utilities, etc.
- "Zestimate" shows Zillow's estimated fair market rent — if listing price is >20% below, flag it

## Sending an inquiry
1. Click "Contact" or "Request a tour" on the listing detail page
2. A modal form opens with fields: name, email, phone, move-in date, message
3. **DO NOT submit** — show the draft to the user first
4. After approval, fill in the fields and click "Send message" or "Request tour"
5. Wait 2 seconds and take a screenshot of the confirmation

## Known traps
- Map view can be slow — switch to list view via the toggle near the top right
- "Save" button (heart icon) requires login — don't rely on saved searches without confirming login
- Some listings redirect to third-party property sites — note the redirect URL for the contacts log
- "Income-restricted" listings have separate application processes — flag these for the user
- Scroll lazily loads more listings — scroll down once or twice before concluding the search
