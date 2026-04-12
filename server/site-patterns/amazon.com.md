# amazon.com

*Verified site pattern notes from a real-browser run on 2026-04-09*

---

## Validation Scope

- Verified against the Amazon search results page for a household product query.
- Verified one real Amazon product page opened from the search results.
- Confirmed visible result-card structure, inline merchandising, location prompt behavior, and top-of-page sponsored modules.
- Variant-selection and cart flows still need deeper validation before they should be documented as verified procedures.

## Effective Patterns

- Prefer starting from the top search bar or a direct search URL rather than guessing deep product URLs.
- Expect the first visible fold to contain a branded or sponsored module before standard results.
- Read each result card carefully: total price, unit price, delivery promise, rating count, “bought in past month,” and badges often all appear together.
- Treat inline `Add to Cart` buttons on search results as optional shortcuts, not the primary path, until cart behavior is validated more thoroughly.

## Result Card Signals

- Cards commonly include image, title, rating stars with review count, a price, unit pricing, and shipping or delivery text.
- Small gray labels such as `Sponsored` or `Featured from Amazon brands` can be easy to miss.
- Cards may include merchandising labels such as `Overall Pick`, `Best Seller`, `#1 Top Rated`, or sustainability-related pills.
- Variation links like `3 sizes` or `7 sizes` may appear directly on the result card.

## Known Traps

- A location toaster can appear below the nav and shift the interpretation of delivery and shipping details.
- Sponsored results are visually close to organic results and can dominate the top fold.
- Unit pricing can sit very close to total pricing, making quick extraction error-prone.
- Promotional copy such as spend-threshold discounts can look like an immediate price reduction when it is not.

## Notes For Future Validation

- Verify whether variant selection is required before cart actions on common household products.
- Verify how region and shipping destination changes affect availability text.

## Verified Product Page Example

- Title was visible near the top of the page and included roll count and sheet count.
- Price was visible with a per-100-sheets unit-price breakdown.
- Rating and review count were clearly displayed on the product page.
- Availability was shown as `In Stock`.
- Shipping and delivery messaging included destination-specific charges and an estimated arrival date.
- Seller information was visible as `Amazon.com`.
- No blockers were encountered during this product-page observation.

---
