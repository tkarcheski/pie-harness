# Operate the local digital-product studio

Install Node.js 22.13 or later. Open the directory that contains `apps/studio`. Node provides SQLite. The fixture writer runs offline without an account or additional packages.

For AI writing, start Ollama on `127.0.0.1:11434` with an installed model. The Studio uses local transports for social posts, ad placements and mail. Store runtime files outside Git on storage you control.

## First run on Windows

```powershell
$studio = Join-Path $env:LOCALAPPDATA 'PIE-Studio-Demo'
node apps/studio/cli.mjs $studio demo
node apps/studio/cli.mjs $studio status
node apps/studio/cli.mjs $studio health
```

Use a fresh directory for each demo. Open the Markdown edition under `deliveries`. Inspect the brand SVG, feed JSON and email files under `channel-export`.

The demo uses fixture text and synthetic orders. Its local ad placement costs zero. An order records a payment observation supplied by the operator. Verify settlement against a separate record.

## Operate your own local studio

Choose a new state directory. Keep that directory for later commands. Pass input as a JSON file or use `-` for standard input. At the prompt, enter an installed Ollama model tag or `fixture`.

```powershell
$studio = Join-Path $env:LOCALAPPDATA 'PIE-Studio'
$model = Read-Host 'Installed Ollama model tag or fixture'
@{ topic = 'Sketchbook Practice'; audience = 'beginning illustrators'; model = $model } | ConvertTo-Json -Compress |
  node apps/studio/cli.mjs $studio init -
node apps/studio/cli.mjs $studio work
```

The worker checks the model's local metadata before calling Ollama. A request has a 15-minute limit. Each job has a one-hour deadline and allows one retry after failure.

Use `work` for one eligible job. Use `serve` to poll continuously. Press Ctrl+C to stop. On restart, the worker recovers expired leases. Use `status` to inspect the task reason and attempt count.

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

The worker can send the approved answer to an exact owner-reviewed FAQ. Other comments and email enter the owner queue. The store commits local posts and replies with job completion. Generated prose has no authority to select recipients, run shell commands, approve refunds, change grants or buy ads.

## Operator-provided VM

1. Use a dedicated OS account and a state directory you control.
2. For a Linux user service, install the distribution at `~/pie-harness`. Initialize a Studio at `~/.local/state/pie-studio`.
3. Install `apps/studio/pie-studio.service` with the user's systemd service manager. Adjust the paths. Ensure the service account can find Node on `PATH`.
4. Start the service. It restarts a failed worker and allows time for an active bounded task to finish at shutdown. The worker runs without privileged administration.

### Back up and restore

The running worker verifies a database snapshot at startup when due and roughly daily thereafter. Keep the matching enrollment key in secure, separate backup storage. Periodically copy the verified snapshot and key to protected off-machine storage.

1. Stop the worker. Copy the verified `latest.sqlite` into a fresh state directory as `studio.sqlite`.
2. Restore the matching `worker.key` with owner-only access.
3. Run `health`. Start `work` or `serve` after a successful check.
4. To regenerate deliveries, repeat `deliver` against recorded orders. The integration suite tests a fresh restore by completing a pending campaign.

## Acceptance evidence and scope

Run `node --test tests/contracts.test.mjs tests/local.test.mjs tests/studio.test.mjs`. The suite terminates a worker process and checks retries, stale-worker fencing, account scopes, duplicate delivery, source review, inbox replay, retirement, health and restore.

The demo runs locally. Live social publishing, paid ads, email, payments and VM deployment each require a separate integration and owner authorization.
