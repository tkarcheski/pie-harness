# Operating the local digital-product channel

Use Node.js 22.13 or newer. Run commands from the public distribution root. Node provides SQLite; the fixture writer needs no account, model, network, package installation or database service. The optional AI writer uses an already installed local model served by Ollama at 127.0.0.1:11434. The channel's social feed, ad placements and mailbox are local transports. Runtime files belong outside Git on operator-controlled storage.

## First run on Windows

```powershell
$studio = Join-Path $env:LOCALAPPDATA 'PIE-Studio-Demo'
node apps/studio/cli.mjs $studio demo
node apps/studio/cli.mjs $studio status
node apps/studio/cli.mjs $studio health
```

Use a fresh directory for each demo. Inspect the Markdown edition under `deliveries` and the brand SVG, feed JSON and email files under `channel-export`. The demo explicitly uses deterministic fixture writing and synthetic orders. The local ad placement spends zero. A recorded order is an operator-supplied payment observation; confirm settlement with its own record.

## Operate your own local studio

Set a new directory and use the same CLI for each command. Each input is a JSON file, or pass `-` to read JSON from stdin.

```powershell
$studio = Join-Path $env:LOCALAPPDATA 'PIE-Studio'
'{"topic":"Sketchbook Practice","audience":"beginning illustrators","model":"qwen3:4b"}' |
  node apps/studio/cli.mjs $studio init -
node apps/studio/cli.mjs $studio work
```

Choose an installed local model tag or the literal value `fixture`. The worker checks the model's local metadata before submitting to Ollama. Each request has a 15-minute limit within the job's one-hour deadline. Failed jobs allow one retry. Run `serve` for continuous polling, or `work` to take one eligible job. Stop the worker with Ctrl+C. A restarted worker recovers expired leases. The owner can inspect each task's reason and attempt count through `status`.

| Command | Input and result |
| --- | --- |
| init | Supply topic, audience and model. The agent creates a name, persona voice, original story and reproducible brand mark. Repeating the same initialization preserves the studio. |
| product | Supply title, source, rightsConfirmed=true, priceMinor in USD cents and optional faq with question and answer. Only submit source material you own or may distribute. Returns a product ID and a drafting task. |
| inspect | Supply product ID as `{"product":"…"}` to review the full source, draft and price. |
| review | Supply product and decision: approve, revise with a note, or retire. Approval fixes the delivery digest and queues a story and ad. The local agent has no owner-review tool. |
| campaign | Supply an approved product ID to queue another chapter and ad. The writer sees the prior chapter, approved product and brand story. |
| schedule | Supply product and minutes. The worker schedules at most one pending campaign per product per interval. Set minutes to 0 to stop recurring campaigns. |
| receive | Supply source (comment or email), eventId, from (alias), body and either post (for a comment) or product (for email). Replayed incoming events are deduplicated. |
| resolve | Supply message (for example email:case-1) and response. The reply goes to its original conversation in the local outbox. |
| order | Supply reference, product, buyer alias, paidMinor and currency (USD). Duplicate matching events return the original order. Conflicting replays are rejected. |
| deliver | Supply reference. Writes the approved edition once, verifies its digest, and places the delivery notification in the local mailbox. Safe to repeat. |
| settle | Supply reference, feeMinor, refundMinor, postedMinor and currency. A nonzero difference remains visible. Sales and bank postings have separate fields. |
| export | Materializes brand artwork, feed and email files. Local delivery envelopes reference the immutable edition in the deliveries directory. |
| health / maintain | Inspect node heartbeat, tasks requiring intervention, free disk and memory, database integrity and last backup. Maintain takes a consistent rolling SQLite snapshot and opens it for verification. |

The worker can answer an exact owner-reviewed FAQ automatically using the approved answer. Other comments and email enter the owner queue. Generated prose is data, and cannot select the recipient, execute shell commands, approve refunds, change authority or purchase ads. Replies and local posts survive worker restarts in the same transaction as job completion.

## Operator-provided VM

Use a dedicated OS user and an operator-controlled state directory. For a Linux user service, place the distribution at `~/pie-harness`, initialize a studio at `~/.local/state/pie-studio`, and use the sample `apps/studio/pie-studio.service` with the user's systemd service manager. Adjust the paths to the installation and ensure the service user's PATH includes Node. The unit restarts a failed worker and allows an in-flight bounded task to finish during shutdown. No provisioning or privileged administration is required by the worker.

While serving, the worker verifies a database snapshot at startup when due and at roughly daily intervals. Store the enrollment key separately in operator-controlled secure backup storage. To restore, stop the worker, copy the verified latest.sqlite into a fresh state directory as studio.sqlite, restore the matching worker.key with owner-only access and run health, then work or serve. Deliveries can be regenerated by replaying deliver against recorded orders. Periodically copy the database snapshot and key to secure off-machine storage for host-loss recovery. The integration suite restores a fresh studio and completes a pending campaign.

## Acceptance evidence and scope

Run `node --test tests/contracts.test.mjs tests/local.test.mjs tests/studio.test.mjs`. Tests include an actual terminated child process, retries, fencing, scope boundaries, duplicate delivery, source review, inbox replay, retirement, service health and database restore. The initial channel runs entirely within the local studio. Connecting a social network, buying placements, sending real email, processing live payments or deploying a VM each requires its own integration and owner authorization.
