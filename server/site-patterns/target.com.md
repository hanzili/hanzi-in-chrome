# target.com

*Verified site pattern notes from a real-browser run on 2026-04-09*

---

## Validation Scope

- Verified against a Target search results page for a paper-towel-related query.
- Confirmed grid-card layout, pricing variants, promo messaging, and fulfillment-filter behavior near the top of the page.
- Product-page and cart behavior still need deeper validation before being documented as verified.

## Effective Patterns

- Read the card carefully before clicking: Target frequently mixes single prices, ranges, sale pricing, and per-unit math.
- Expect promo language such as gift-card offers or `Highly rated` badges to appear on many cards.
- Use top-of-page fulfillment shortcuts as navigation aids, but do not assume availability from them alone.
- Treat adjacent-category items as noise until the title is confirmed; search results can include loosely related products.

## Result Card Signals

- Cards commonly show image, title, star rating and review count, and a persistent `Add to cart` button.
- Price presentation can include a range, a sale price plus regular price, and per-unit calculations.
- Promo copy such as Target gift card offers can repeat across many cards.
- A deals carousel may appear above or between standard results.

## Known Traps

- Price comparisons are easy to misread because of mixed range pricing, per-unit math, and sale formatting.
- Promo copy can dominate the visual hierarchy and obscure the actual base price.
- Search results may include adjacent products that are not a clean match for the intended household item.
- Fulfillment filters are visible near the top, but card-level availability may still require deeper inspection.

## Notes For Future Validation

- Verify whether product pages consistently expose fulfillment, seller/brand, and review details in predictable places.
- Verify whether cart actions from search results behave differently from cart actions on the product page.
- Verify whether Circle promotions introduce extra modal or eligibility steps.

---
