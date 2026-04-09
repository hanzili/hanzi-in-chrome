# ebay.com

*Verified site pattern notes from a real-browser run on 2026-04-09*

---

## Validation Scope

- Verified against an eBay search results page for a household product query.
- Confirmed repeated result-card layout, subtle sponsored labeling, shipping/location messaging, and pricing complexity.
- Product-page and cart behavior still need additional validation before being treated as verified.

## Effective Patterns

- Use a direct search URL or the top search bar, then read multiple cards before choosing a listing.
- Treat the headline price as incomplete until shipping, coupon, and `Best Offer` text are checked.
- Review condition and shipping source before clicking; both are visible early and help filter out noisy results.
- Expect curated and sponsored modules to interrupt organic listings.

## Result Card Signals

- Cards commonly show title, condition, rating or seller reputation signals, headline price, shipping cost, and location.
- Some cards show range pricing or `or Best Offer` instead of a single fixed price.
- Promo elements such as `Save up to 10% when you buy more`, `with coupon`, `Free returns`, or urgency badges often appear below the price.
- Location and shipping details may indicate cross-border sellers even for simple household-product queries.

## Known Traps

- Sponsored labeling is subtle and easy to overlook on both individual cards and featured carousels.
- Shipping cost is frequently separated from the main price, so quick extraction can understate the real cost.
- Coupon language and range pricing create ambiguity until the listing page is opened.
- Watcher counts and urgency labels can distract from shipping and fulfillment quality.

## Notes For Future Validation

- Verify how listing pages surface seller details, returns, and shipping estimates.
- Verify the add-to-cart path on fixed-price listings versus auction-style or `Best Offer` listings.
- Verify whether filters meaningfully change result quality for common product research tasks.

---
