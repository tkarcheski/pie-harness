# Owned-item resale desk

## Verify a sale from intake to settlement

Use Node.js 24. From the distribution root, run the synthetic sale.

~~~sh
node apps/resale/rehearsal.mjs
~~~

The rehearsal uses two temporary SQLite databases. Follow the item through evidence review, pricing from dated completed sales and owner approval of the exact listing. The test recipient publishes the listing and the response is lost.

On restart, the shop reads the recipient's receipt before sending further writes. It records the sale and shipment, then ends the listing. Check the payout. A partial refund and fee reduce the $22 sale to a matched $17.60 bank observation.

## Run an operator workspace

~~~sh
node apps/resale/cli.mjs DIRECTORY init
node apps/resale/cli.mjs DIRECTORY intake INPUT.json
node apps/resale/cli.mjs DIRECTORY status
node apps/resale/cli.mjs DIRECTORY queue
~~~

Choose a private directory outside Git. Supply input as a JSON file or use `-` for standard input. Use stable opaque IDs, ISO UTC timestamps and integer minor units in the stated currency.

The CLI binds the owner, agent and simulated eBay account once. Its recipient uses a second local database. Stop both writers and back up both databases together. The installed CLI needs no API key.

Restrict the review, exact-approval and reconciliation interfaces to a trusted owner process. Protect both databases with OS access controls.

Keep photos, provenance documents, bank records, tracking numbers, marketplace responses and customer communications in a restricted evidence store. Use opaque references such as `vault:sample-receipt`. Protect the reference map. The desk checks reference syntax. The owner verifies the evidence.

### Intake and drafts

| Command | Input |
| --- | --- |
| intake | eventId, id, title, matchKey, quantity, ownership, condition. Optional photoRefs, provenanceRef and rightsRef. |
| review | eventId, itemId, reviewRef and updated evidence fields. The owner reviews the physical item and records outstanding uncertainty. |
| draft | eventId, listing id, itemId, currency, comparables and optional priceMinor. Use the same listing id to revise a draft. |
| listing | listingId. Returns references, observation dates, the included range and missing-evidence flags. |

### Check the pricing evidence

1. Select ownership from `owned`, `uncertain` and `third-party`. Record condition as `new`, `like-new`, `good`, `fair`, `poor`, `parts` or `unknown`.
2. Use `matchKey` to identify the product, variant, size or edition. For each comparable, provide a unique `sourceRef`, `observedAt`, `kind` (`sold` or `ask`), `matchKey`, condition, currency and `amountMinor`.
3. Inspect the minimum, maximum and median of matching completed sales in the last 90 days. The proposed price defaults to the median. With at least three comparable records, confidence is corroborated. With one or two, it is limited. With zero, the range is unpriced.
4. Check the missing-evidence flags even if the owner provides a price. After a new inspection, draft the listing again before publication. Classify proceeds from an owned item as liquidity.

### Marketplace writes

| Command | Input |
| --- | --- |
| preview-write | operationId, listingId, verb (publish or end). Review the returned price, quantity, account-bound proposal and digest. |
| approve-write | The reviewed operationId, listingId, verb, expectedDigest from preview-write, and expiresAt |
| submit-write | The same operationId, listingId and verb |
| reconcile-write | operationId |

The proposal binds the actor, seller account, operation ID, listing version, price and serialized payload digest. Submission consumes exact owner approval and checks the current account scope. Each listing supports one pending operation. An identical submission returns the saved outcome.

If the response is lost, keep the pending write through restart. Use `reconcile-write` to check the recipient. A confirmed write completes the operation. Verified absence permits a new ID and a new approval. An unknown result stays in the owner queue.

Connector calls accept a cancellation signal. The default timeout is 15 seconds. A transport can set `timeoutMs` up to 15 minutes.

### Connect an eBay Sandbox account

1. Bind an existing owner, business, actor and rehearsal or sandbox account with `bindResaleDesk(store, scope)`.
2. Register platform `ebay-sandbox` in Accounts. Use the application scopes `ebay.read`, `ebay.publish` and `ebay.end` as needed.
3. Construct `EbaySandboxOffers` from `packages/resale/ebay.mjs` with the store, owner, account ID and a trusted `resolveAccessToken(secretRef, signal)` function. eBay offer writes require the `sell.inventory` user scope. The adapter permits the Sandbox origin and rejects redirects.

4. Prepare a single-SKU fixed-price Sandbox offer. Include your seller policies, images and location. Run `inspect(offerId)` and review the offer terms and inventory record.
5. Supply `offerId` and the inspected digest in `draft.ebayOffer`. Before publication, the adapter verifies the snapshot, price, quantity, currency, condition and title. Before ending an offer, it verifies the current listing ID.

An ambiguous remote state remains pending. The transport supports two-decimal USD, EUR, GBP, CAD and AUD prices. The release tests use mocked protocol responses and a persistent synthetic recipient. Hosted account certification requires an authorized Sandbox test seller. [eBay Inventory API](https://developer.ebay.com/api-docs/master/sell/inventory/openapi/3/sell_inventory_v1_oas3.json)

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

Use the same order and line IDs for repeated notifications. A line counts once. Send conflicting updates for review. Include all seller-attributable gross across the line quantity and any buyer-paid delivery that belongs in the seller payment.

The eBay importer removes buyer identity fields, checks ship-by dates and verifies line sums. For unexplained totals, tax, promotion or refund adjustments, submit a reviewed normalized order with its original statement reference. Record the corresponding settlement lines.

Recording a shipment creates no customer message. Open an owner case for `late-shipment`, `carrier-delay`, `damage`, `return` or `buyer-inquiry`. Before closure, record physical tracking evidence and the resolution. [eBay Fulfillment API](https://developer.ebay.com/api-docs/master/sell/fulfillment/openapi/3/sell_fulfillment_v1_oas3.json)

### Settlement

| Command | Input |
| --- | --- |
| payout | eventId, id, reported netMinor, currency, observedAt, evidenceRef |
| settlement-line | eventId, unique marketplace transaction-line id, payoutId, orderId, kind (sale, fee or refund), positive amountMinor, currency, observedAt, evidenceRef |
| bank-observation | eventId, unique bank transaction id, payoutId, signed amountMinor, currency, observedAt, evidenceRef, matchRef |
| payout-report | payoutId |

1. Use recipient IDs for the order, transaction, payout and bank observations. Match a bank record with an explicit remittance reference. An equal amount alone is insufficient.
2. Record partial refunds against the original order. Across statements they can total up to the order gross. A duplicate transaction keeps its first assignment. A conflicting assignment, currency mismatch or excess refund rolls back the transaction.
3. Compare the statement net, sales less fees and refunds, and the read-only bank observations. Resolve unexplained differences in the owner queue with matching evidence.
4. Check `order-report` for outstanding proceeds even when an individual payout matches. These figures measure cash settlement. To calculate profit, verify costs and expenses.
