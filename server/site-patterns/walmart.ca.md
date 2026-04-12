# walmart.ca

*Verified site pattern notes from a real-browser run on 2026-04-09*

---

## Validation Scope

- Verified against Walmart search results and a Walmart.ca product page in a real browser.
- Confirmed sponsored hero behavior, result-card structure, fulfillment messaging, and location-sensitive prompts.
- Verified that Walmart.com entry can be interrupted before normal browsing starts.
- Product-page and cart flows on Walmart.com still need separate validation before they should be documented as verified procedures.

## Effective Patterns

- Search results can be read effectively from the main grid without opening a product page first.
- Compare headline price with the fulfillment line; Walmart exposes delivery, shipping, and pickup context very early.
- Watch for inline `Add` buttons directly on result cards.
- Use caution around sponsored hero modules at the top of the results page, which can dominate the first screen.

## Result Card Signals

- Cards commonly show brand, product title, stacked price styling, rating count, and fulfillment messaging.
- Fulfillment details can include combinations such as delivery window, shipping arrival, and pickup timing.
- Promotional labels such as `Rollback` and `Now $X, Was $Y` can appear alongside unit pricing.
- Some cards surface `Add` buttons without requiring a click through to the product page.

## Known Traps

- Location and pickup context can be driven by a persistent `Pickup or delivery?` banner.
- If the flow is started on `walmart.com`, a storefront or region-selection step can appear before normal browsing continues.
- In validation on `walmart.com`, the browser agent did not successfully continue past the region-selection flow without help.
- During validation on `walmart.com`, a `human or robot` verification step appeared and required manual intervention before the flow could continue.
- Supplemental validation on Walmart.ca hit a `Press & Hold` human verification challenge under a blocked URL flow; in that run, the browser agent could not clear the challenge autonomously.
- Sponsored modules and hero placements can pull attention away from standard results.
- `Uses item details. Price when purchased online` messaging means price context may not match in-store assumptions.
- Filter chips along the top are easy to activate accidentally and can narrow the result set unexpectedly.

## Notes For Future Validation

- Verify the product-page layout for title, seller, reviews, and availability on Walmart.com after the storefront flow is resolved.
- Verify add-to-cart behavior and whether quantity or fulfillment mode must be selected first.
- Verify whether store location changes meaningfully alter pricing or stock visibility.

---
