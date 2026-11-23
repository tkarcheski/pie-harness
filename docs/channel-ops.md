# Research and channel operations

Use the channel desk to research an opportunity, compare its economics and run a measured local product release. It shares the SQLite database and worker queue used by the digital-product Studio. Studio creates the product, writes the edition, runs the campaign and serves observed orders. The desk records the evidence, rights, approvals, experiment limits and owner decisions that govern those actions.

## Run the internal experiment

From a standalone checkout with Node.js 24, choose a new directory outside Git.

~~~sh
node apps/channel-ops/cli.mjs /path/to/new-state rehearse
node apps/channel-ops/cli.mjs /path/to/new-state status
~~~

The exercise generates a collection intake guide from original fixture material. It reads the generated Markdown and counts required fields against the prior edition. A complete run measures four of four fields against one of four, or a gain of 7,500 basis points in editorial coverage. It records a local approval, one maintenance observation, a continuation within the original caps and a final stop. The result includes the edition digest, costs and owner time. All accounts and commercial assumptions in this exercise are synthetic. No live publication, customer demand or revenue is inferred from the field check.

For ordinary work, initialize the workspace with the Studio CLI, then run the desk against that directory. Keep owner evidence and databases outside the repository. Both CLIs accept a JSON file after the command or a dash for standard input.

~~~sh
node apps/studio/cli.mjs /path/to/state init brand.json
node apps/studio/cli.mjs /path/to/state work
node apps/channel-ops/cli.mjs /path/to/state research-open hypothesis.json
node apps/channel-ops/cli.mjs /path/to/state opportunity-rank
~~~

Each desk mutation needs a stable requestId. After an interrupted response, repeat the exact JSON using the same ID to get its original receipt. Conflicting reuse fails. Multiple processes serialize their writers through the Studio store. status, research-get and opportunity-rank take optional query fields and require no request ID. State inspection also settles elapsed timers. The Studio worker performs scheduled checks through its normal tick when serve is running.

An evidence object contains ref, observedAt and note. Use a publicly shareable HTTPS URL or a private opaque evidence:, studio: or document: locator. Keep secrets, personal details and access tokens out of references. Times accept Unix milliseconds or ISO timestamps with an explicit time zone.

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

Source IDs identify the original source. A syndicated quote should use its original source ID. Distinct-ID and distinct-origin counts both have to meet the target. The desk uses the hostname of HTTPS evidence and the full opaque locator of local evidence. Repeated observations from the same source cannot independently establish support. Any contradictory finding closes the study as challenged. Remaining uncertainties, exhausted retries, elapsed duration or the owner's stop are retained with their reasons. The operator is responsible for interpreting claims against the criterion and identifying independent sources.

The five economic fields are net contribution in USD cents (contributionMinor), time to cash in days (cashDays), delivery reliability in basis points (reliabilityBps), growth in basis points (growthBps) and operator effort in minutes (ownerMinutes). Use a common observation horizon when comparing opportunities. Enter a null or omit an unknown field. A measured zero counts as evidence.

Each metric uses its most recent dated observation if present, otherwise the forecast. The report preserves the original forecast and observations. Default weights are 35, 15, 20, 15 and 15 in the order above. Normalization caps each metric at 0–1. Contribution and growth reach full score at 10,000 cents and 10,000 basis points; losses and negative growth earn zero. Reliability is divided by 10,000. The time-to-cash and effort components decline linearly to zero at 90 days and 240 minutes. The weighted sum is reported on a 100-point scale. Missing inputs contribute zero and flag the opportunity for evidence collection. Eligible, incomplete and out-of-limit opportunities have separate priority tiers. Owner overrides reorder within a tier.

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

After registration, run Studio product with rightsConfirmed and the list of rights document IDs in rights. Run Studio work to write the draft. Plan and approve the experiment in the channel desk, then release the reviewed edition with Studio review and decision approve. A registered channel enforces permissions in the Studio entry points, including rechecking the grant at campaign commit if a worker was still generating when it was revoked. Owner approvals, grants, document reviews, ranking overrides and final decisions are available only to the trusted local operator. The embeddable deskCommand defaults to the restricted agent role. Local database and CLI access are part of the trusted workstation boundary.

The health check runs immediately on registration, on its configured interval when Studio serve is operating, or during workspace activity after downtime. It records missed intervals, outstanding support and failed work. Pending reviews, obligations due for renewal, expired rights and rolled-back experiments enter the core owner's alert queue. Review an item with new evidence to resolve the alert. When a grant expires, a required right fails, a cap is reached, time expires or the sampled result crosses the rollback threshold, the desk retires the local edition and disables further campaigns. Previously observed orders can still receive their recorded edition. Retiring a local edition has no effect on copies a recipient already received.

Experiments expose the counted baseline, per-window outcomes, effort, incurred costs, and the difference in success rates in basis points. Actual costs above a cap are recorded and trigger a stop. External promotion, charges and live releases require separate authorized integrations. This local transport incurs zero publication spend.
