# Owned-item resale desk

Run the complete synthetic sale from the distribution root with Node.js 24.

~~~sh
node apps/resale/rehearsal.mjs
~~~

The rehearsal uses two temporary SQLite databases. It receives an owned item, reviews its evidence, prices it from dated completed sales, approves an exact listing, and loses the marketplace response after publication. It reopens the shop, reads the recipient's receipt, records the sale and shipment, and ends the listing. A partial refund and fee reduce the $22 sale to a matched $17.60 bank observation. The fixture uses a separate recovery lookup before sending further writes.

## Run an operator workspace

~~~sh
node apps/resale/cli.mjs DIRECTORY init
node apps/resale/cli.mjs DIRECTORY intake INPUT.json
node apps/resale/cli.mjs DIRECTORY status
node apps/resale/cli.mjs DIRECTORY queue
~~~

Choose a private data directory outside Git. Supply a JSON input file or a dash for standard input. Use stable opaque identifiers and ISO UTC timestamps. Monetary amounts use integer minor units in the stated currency. The CLI binds its owner, agent and simulated eBay account once. Its recipient is a second local database. Back up both databases together with their writers stopped. The installed CLI requires no API keys.

Only a trusted owner process should receive the review, exact approval and reconciliation interfaces. Protect both databases with operating-system access controls. Store photographs, provenance documents, bank records, tracking numbers, raw marketplace responses and customer communications in an access-controlled evidence store. Reference them with opaque handles such as `vault:sample-receipt`. Protect the mapping between each handle and its source. The desk validates reference syntax. The owner verifies the underlying evidence.

### Intake and drafts

| Command | Input |
| --- | --- |
| intake | eventId, id, title, matchKey, quantity, ownership, condition. Optional photoRefs, provenanceRef and rightsRef. |
| review | eventId, itemId, reviewRef and updated evidence fields. The owner reviews the physical item and records outstanding uncertainty. |
| draft | eventId, listing id, itemId, currency, comparables and optional priceMinor. Use the same listing id to revise a draft. |
| listing | listingId. Returns references, observation dates, the included range and missing-evidence flags. |

Choose ownership from owned, uncertain and third-party. Supported conditions are new, like-new, good, fair, poor, parts and unknown. The matchKey identifies the particular product, variant, size or edition. Each comparable includes a unique sourceRef, observedAt, kind (sold or ask), matchKey, condition, currency and amountMinor. The range is the minimum and maximum of matching sales in the last 90 days. The default proposed price is their median. Three or more separate comparable records produce corroborated confidence. Fewer produce limited confidence, and zero leaves the range unpriced. Owner-supplied prices retain their evidence flags. A refreshed item inspection requires a new draft before publication. The classification for proceeds from these owned items is liquidity.

### Marketplace writes

| Command | Input |
| --- | --- |
| preview-write | operationId, listingId, verb (publish or end). Review the returned price, quantity, account-bound proposal and digest. |
| approve-write | The reviewed operationId, listingId, verb, expectedDigest from preview-write, and expiresAt |
| submit-write | The same operationId, listingId and verb |
| reconcile-write | operationId |

The proposal binds the actor, seller account, operation ID, listing version, price and serialized payload digest. A write consumes exact owner approval and checks the current scoped account. One listing can have one pending operation. A repeated submission returns the saved outcome. A lost response leaves the write pending across restart. Use recipient readback for applied, verified absent or unknown. A verified absence permits a new operation ID and approval. An unknown result stays in the owner queue. Connector calls default to 15 seconds and accept a signal. A transport can set timeoutMs up to 15 minutes.

The optional **eBay Sandbox** adapter lives in `packages/resale/ebay.mjs`. Applications may bind an existing owner, business, actor and rehearsal or sandbox account with `bindResaleDesk(store, scope)`. Use an Accounts record with platform `ebay-sandbox` and application scopes `ebay.read`, `ebay.publish` and `ebay.end` as required. Instantiate EbaySandboxOffers with the store, owner, account ID and a trusted resolveAccessToken(secretRef, signal) function. eBay's user authorization uses the sell.inventory scope for offer writes. The adapter targets only the eBay Sandbox origin and rejects redirects.

Prepare a single-SKU fixed-price offer in the sandbox with your seller policies, images and location. Call inspect(offerId), review its offer terms and inventory record, and supply its offerId and digest in draft.ebayOffer. The adapter verifies the approved remote snapshot, price, quantity, currency, condition and title immediately before publishing. Ending an offer verifies its current listing ID. An ambiguous state after a lost receipt remains pending. The transport supports two-decimal USD, EUR, GBP, CAD and AUD prices. This release verifies mocked protocol responses and a persistent synthetic recipient. A hosted sandbox-account certification requires its own authorized test seller. [eBay Inventory API and operation definitions](https://developer.ebay.com/api-docs/master/sell/inventory/openapi/3/sell_inventory_v1_oas3.json)

### Fulfillment and owner work

| Command | Input or result |
| --- | --- |
| order | eventId, id, orderedAt, shipBy, currency, evidenceRef and paid lines. Each line supplies lineId, marketplaceListingId, quantity and grossMinor. |
| order-from-ebay | eventId, evidenceRef and an order object from eBay's Fulfillment API. Imports supported paid single-currency orders with traceable line totals. |
| ship | eventId, orderId, trackingRef and shippedAt |
| exception | eventId, orderId, caseId, reason, dueAt and evidenceRef |
| close-exception | eventId, orderId, caseId and resolutionRef |
| ack-late | eventId, orderId and resolutionRef |
| queue | Open owner handoffs, sorted by due time with overdue flags |
| order-report | orderId. Returns shipment and case status, gross, fees, refunds and remaining unsettled gross. |

An external order ID can arrive on multiple notifications. A line is counted once, and conflicting updates need review. Gross is the actual seller-attributable line amount across its quantity. Include buyer-paid delivery where it belongs in the seller payment. The eBay importer discards buyer identity fields, checks ship-by dates, and verifies each line sum. Unexplained totals, tax, promotion or refund adjustments require a reviewed normalized order with its original statement reference. Record the corresponding financial adjustments as settlement lines. A new shipment creates no customer message. A support case records an owner action for late-shipment, carrier-delay, damage, return or buyer-inquiry. Record physical tracking evidence and a resolution before closing the work. [eBay Fulfillment API definitions](https://developer.ebay.com/api-docs/master/sell/fulfillment/openapi/3/sell_fulfillment_v1_oas3.json)

### Settlement

| Command | Input |
| --- | --- |
| payout | eventId, id, reported netMinor, currency, observedAt, evidenceRef |
| settlement-line | eventId, unique marketplace transaction-line id, payoutId, orderId, kind (sale, fee or refund), positive amountMinor, currency, observedAt, evidenceRef |
| bank-observation | eventId, unique bank transaction id, payoutId, signed amountMinor, currency, observedAt, evidenceRef, matchRef |
| payout-report | payoutId |

Use the recipient's identifiers for order, transaction, payout and bank observations. A bank match needs an explicit remittance reference. A matching amount on its own cannot identify a payout. Partial refunds across several statements may sum to the original order value. Reimporting the same transaction preserves its first assignment. A conflicting assignment, currency mismatch or refund above the order gross rolls back the transaction. Each payout compares the statement's net with the sum of sales less fees and refunds and with read-only bank observations. The owner queue surfaces unexplained differences until the underlying evidence matches. The order report shows outstanding proceeds even when a single payout already matched. These reports measure cash settlement. Profit measurement additionally requires verified cost and expense evidence.
