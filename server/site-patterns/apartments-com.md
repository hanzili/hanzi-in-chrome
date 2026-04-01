---
domain: apartments.com
aliases: [Apartments.com]
updated: 2026-04-01
verified: false
---

## Platform traits
- One of the largest US apartment listing aggregators
- Has a built-in structured application flow (background check, credit check)
- Listings are managed by property management companies, not individual landlords
- Strong filter system — location, price, beds, move-in date, amenities all filterable from the main page
- SPA — wait 3–4 seconds after navigation or filter changes before reading

## Navigating to search
- Homepage: `https://www.apartments.com/`
- Type city/zip in the search bar and press Enter
- Or use direct URL: `https://www.apartments.com/[city]-[state]/`
  - Example: `https://www.apartments.com/boston-ma/`
- After landing on results, wait 4 seconds before reading — listings load asynchronously

## Applying filters
Filters appear as a bar below the search box:
- **Price**: "Price" dropdown — set min/max
- **Beds**: "Beds" dropdown — select count
- **Move-in**: "Move-in Date" picker
- **More**: pets, parking, laundry, amenities

URL encodes filter state — after applying filters, copy the URL to resume later.

## Reading results
- Default is list view — each card shows: price, address, beds/baths, photo, "Contact" button
- Switch between list and map view with toggle at top right
- Cards may show "Specials" (first month free, etc.) — note these in comparison table
- Scroll down to load more results (lazy loading)
- Use `get_page_text` for reliable content extraction — `read_page` may miss card details

## Listing detail page
- Full floor plan options with individual pricing (e.g., 1BR from $1,800, 2BR from $2,400)
- Photo gallery, amenities list, pet policy, parking details
- "Check Availability" or "Contact" button on right sidebar
- Move-in specials prominently shown if available
- Map showing location + commute options

## Sending an inquiry ("Send Message")
1. Click "Contact" or "Send Message" on the listing page
2. A panel or modal opens: name, email, phone, move-in date, message field
3. **DO NOT submit** — show the draft to the user first
4. After approval, fill fields and click "Send Message"
5. Screenshot the confirmation screen

## Built-in application flow
Apartments.com has a "Apply Now" button on some listings that initiates a full application:
- Requires creating an account
- Collects: personal info, rental history, employment, income
- May charge an application fee ($35–$75) — **always warn the user before proceeding**
- Requires credit/background check authorization — stop and confirm before accepting
- **Never proceed past the fee/authorization screen without explicit user approval**

## Known traps
- "Check Availability" vs "Apply Now" — the first is an inquiry, the second starts a formal application. Don't confuse them.
- Application fees are non-refundable — always flag the fee amount before submitting
- Some "listings" are ads for other services — skip cards without a real address
- Floor plan pricing may differ from the headline price — verify the specific unit price
- Phone number is sometimes hidden behind "Show phone number" click — click it before recording contact info
