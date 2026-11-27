# Research and channel operations

The channel desk shares the digital-product Studio's SQLite database and worker queue. Use the desk to research an opportunity, compare economics and authorize a measured local release. It records evidence, rights, approval, experiment limits and owner decisions. The Studio creates the product, writes the edition, runs the campaign and serves observed orders.

## Run the internal experiment

From a standalone checkout with Node.js 24, choose a new directory outside Git.

~~~sh
node apps/channel-ops/cli.mjs /path/to/new-state rehearse
node apps/channel-ops/cli.mjs /path/to/new-state status
~~~

The exercise generates a collection intake guide from original fixture material. It compares required fields in the generated Markdown with the previous edition. The expected result is four of four fields against one of four. This gives a gain of 7,500 basis points in editorial coverage.

Check the local approval, maintenance observation, continuation under the original caps and final stop. Inspect the edition digest, costs and owner time. The fixture uses synthetic accounts and commercial assumptions. Field coverage measures editorial quality. Customer demand and revenue require separate evidence.

For ordinary work, initialize the state directory with the Studio CLI. Point the channel desk to the same directory. Keep owner evidence and databases outside Git. Both commands accept a JSON file. Use `-` for standard input.

~~~sh
node apps/studio/cli.mjs /path/to/state init brand.json
node apps/studio/cli.mjs /path/to/state work
node apps/channel-ops/cli.mjs /path/to/state research-open hypothesis.json
node apps/channel-ops/cli.mjs /path/to/state opportunity-rank
~~~

Give each operation that changes the desk a stable `requestId`. If the response is interrupted, repeat the exact JSON and ID to get the original receipt. Reusing the ID with different input fails. The Studio store serializes writers from multiple processes.

`status`, `research-get` and `opportunity-rank` accept optional query fields without a request ID. Inspecting state settles elapsed timers. While `serve` runs, the Studio worker checks scheduled work on its normal tick.

An evidence object contains `ref`, `observedAt` and `note`. Use a shareable HTTPS URL or a private opaque reference with the `evidence:`, `studio:` or `document:` prefix. Exclude secrets, personal details and access tokens. Supply Unix milliseconds or an ISO timestamp with an explicit time zone.

## Research and ranking

| Command | Fields and behavior |
| --- | --- |
| research-open | Set id, hypothesis and criterion. Configure durationMinutes (1–60), stepMinutes (1–15), maxRetries (0–10), maxAttempts (1–100) and minSources. The distinct-source target must fit the attempt cap. |
| research-begin | Supply id and question. The returned attempt ID and deadline authorize recording one outcome. Only one attempt may run at a time. |
| research-result | Supply id, attempt, status, sourceId, claim and evidence. Use supports, contradicts or uncertain. For a failed attempt supply status failed and a reason. A late or superseded attempt cannot submit results. |
| research-stop / research-get | End a study early with id and reason, or read it with id. The record includes the questions, timed-out attempts, findings, completion time and stop reason. |
| opportunity-record | Supply id, supported study, title, category, forecast and evidence. Choose recurring or liquidity. Use an empty forecast when economics are unknown. |
| opportunity-actual | Supply id, metrics and dated evidence from a completed observation or settlement. Record an independent line or observation window once. |
| opportunity-settlement | Reconcile one closed Studio experiment into its opportunity using id, experiment, costsComplete and dated owner evidence. It matches the orders attributed at intake to that experiment, requires every payout to reconcile and computes USD contribution from net receipts less recorded additional costs. Owner effort stays in minutes. Keep fees and refunded amounts already included in the settlement out of additional costs. |
| opportunity-rank | Optionally filter category, specify weights and set maximum cashDays and ownerMinutes in limits. Results include the selected basis and source for each metric, missing fields, binding constraints, score and override. |
| opportunity-override | Supply id, priority (1–100), and an owner reason. A null priority clears the override. The owner decision history is retained. |

### Count independent sources

Assign a stable ID to the original source. Give a syndicated quote the ID of its original publisher. Both the count of distinct IDs and the count of distinct origins must meet the target. For HTTPS, the desk uses the hostname. For local evidence, it uses the full opaque reference.

Repeated observations from one source cannot establish independent support. A contradictory finding closes the study as challenged. The desk keeps the reason for uncertainty, retry exhaustion, deadline or an owner stop. The operator interprets claims against the criterion and checks source independence.

### Compare the scores

| Metric | Field | Unit | Default weight |
| --- | --- | --- | --- |
| Net contribution | `contributionMinor` | USD cents | 35 |
| Time to cash | `cashDays` | Days | 15 |
| Delivery reliability | `reliabilityBps` | Basis points | 20 |
| Growth | `growthBps` | Basis points | 15 |
| Operator effort | `ownerMinutes` | Minutes | 15 |

Compare opportunities over the same observation horizon. Omit an unknown value or supply `null`. Record a measured zero as zero.

For each metric, the desk uses the most recent dated observation or its forecast. The report keeps both. Each normalized component ranges from zero to one. Contribution reaches one at 10,000 cents. Growth reaches one at 10,000 basis points. Losses and negative growth earn zero. Reliability is divided by 10,000. Time to cash and effort decline linearly to zero at 90 days and 240 minutes.

The weighted score uses a 100-point scale. Missing inputs contribute zero and flag the opportunity for evidence collection. Eligible, incomplete and out-of-limit opportunities use separate priority tiers. An owner override changes the order within its tier.

## Rights, release and maintenance

| Command | Fields and behavior |
| --- | --- |
| channel-register | Supply personaName, channelName and ownership evidence. The registration attaches the Studio's durable owner, persona and channel IDs. Set healthMinutes for recurring checks (default 60). Registering an existing studio puts previously available products back into owner review and pauses their campaigns. Already-paid deliveries retain their original edition. |
| channel-grant / channel-revoke | Grant the Studio actor one scope (draft or publish-local), validUntil and evidence. Revoke a scope with its name and reason. Granting publish-local permits local operation of an owner-approved edition. |
| document-register | Supply id, type (right or obligation), title, responsible, evidence, reviewBy and optional validUntil. Rights require validUntil. Documents enter pending review. |
| document-review | Supply id, status (approved, rejected or pending), note and evidence. Set a new reviewBy to complete overdue review. Renew an expired right with fresh sourced documentation. |
| product-rights | Attach rights document IDs to an existing product with product and rights. Retire a currently available edition before changing its references. A retired edition reenters review for a new bounded plan. |
| experiment-plan | Supply id, product, opportunity, hypothesis, metric, baseline, endsAt, costCapMinor, ownerCapMinutes, minTrials, rollbackBelowBps and targetDeltaBps. A baseline includes trials, successes and dated evidence. Use the same success/trial definition throughout. |
| experiment-approve | The owner supplies id and note after reviewing the exact edition. Approval binds the digest, product, channel and existing immutable plan. |
| experiment-observe | Supply id, startAt, endAt, trials, successes, ownerMinutes, costMinor, maintenance and evidence. Use distinct sources and nonoverlapping measured windows. Late observations within the period actually operated can be recorded after stopping. |
| experiment-decide | Supply id, decision (stop or continue) and reason. Continue requires sufficient samples, the target and remaining caps. It retains the original deadline and budgets. |
| health-check / status | Run an immediate check or inspect the latest health status, scheduled due time, open obligations, failed work, support queue, decision receipts and current experiment state. |

### Release an edition

1. Register the channel. Run Studio `product` with `rightsConfirmed` and the list of rights document IDs in `rights`.
2. Run Studio `work` to produce a draft. Plan the experiment in the channel desk and obtain owner approval.
3. Release the reviewed edition with Studio `review` and decision `approve`. A registered channel enforces its grants in the Studio entry points. The worker checks the grant again when committing a campaign, including when it was revoked during generation.

The trusted operator controls approvals, grants, document reviews, ranking overrides and final decisions. The embeddable `deskCommand` defaults to the restricted agent role. Protect local database and CLI access on the trusted workstation.

### Handle maintenance alerts

The desk checks health at registration, on the configured interval during Studio `serve`, and on workspace activity after downtime. It records missed intervals, outstanding support and failed work. Pending reviews, renewal obligations, expired rights and rolled-back experiments appear in the owner's alert queue. Resolve the item by reviewing new evidence.

A grant expiry, failed right, reached cap, elapsed deadline or crossed rollback threshold retires the local edition and disables further campaigns. Previously observed orders can still receive their recorded edition. Recipients can retain copies they already received.

Check the counted baseline, each observation window, effort, costs and the change in success rate in basis points. Costs above a cap still enter the ledger and trigger a stop. Local publication costs zero. External promotion, charges and live releases require separate authorized integrations.
