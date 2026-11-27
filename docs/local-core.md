# Controlled local execution

## Check startup

Use Node.js 22.13 or later and its bundled SQLite driver. Run `node apps/control-plane/local.mjs`. The fixture validates its versioned configuration, opens an in-memory database, enrolls a synthetic worker and runs one task. Check the printed checkpoint. All connectors are disabled for this check.

For a custom configuration, pass the filename as the first argument or set `PIE_CONFIG`. The argument takes precedence. For persistent state, set `PIE_STATE_DB` to a path outside the checkout.

## Records and migration

The store represents owners, businesses, personas, agents, external accounts, channels, opportunities, experiments, runs, tasks, attempts, actions and artifacts. Each record has a stable UUID, owner, UTC creation time in epoch milliseconds and version.

The store checks parent type and owner. An attempt references its task and node. An artifact references its producing attempt. The opportunity holds its forecast. A task references its experiment and budget. Unknown economics can stay unset. For an estimate, supply minor-unit ranges, currency, horizon, review date and evidence references.

SQLite stores a transactional state document. `BEGIN IMMEDIATE` serializes competing writers. Migration from user version 1 to version 2 preserves execution records and adds policy, approval and intervention collections. The store targets a small local workspace. Before replication or high-throughput deployment, review persistence and authentication separately.

## Task transitions

| From | Event | To |
| --- | --- | --- |
| queued | Dependencies complete, qualified node with spare capacity claims | running |
| queued | Prerequisite failed, canceled or blocked | blocked |
| running | Worker completes under a current fence | done |
| running | Failure or expiry with safe replay and retries left | queued |
| running | Failure or expiry at retry limit | failed |
| running | Unconfirmed effect at interruption or cancellation | needs-reconciliation |
| needs-reconciliation | Owner supplies recipient evidence | done if confirmed, otherwise queued or failed according to retry limit |
| queued, running or blocked | Owner cancellation with no pending effect | canceled |

### Replace an unavailable worker

A worker sends a health heartbeat. A trusted supervisor records versioned capability probes. Enrollment issues a revocable node ID and secret token. The database stores the token hash.

The scheduler excludes unhealthy, stale, draining, unqualified and full nodes. It limits lease renewal to the last heartbeat's freshness window. Before dispatch, recovery clears expired claims. The replacement worker receives the prior artifact reference and a new fence. A worker with the old fence cannot commit.

## Account and authority boundary

1. Register the platform, owner, recovery owner, action scopes, expiry and opaque secret reference.
2. For development, keep synthetic secrets in the in-memory provider. For a vault, implement asynchronous `resolve(reference)`. Deliver the secret only to a trusted connector.
3. Inspect the account probe. It returns a boolean and records an intervention on failure. It suppresses provider errors that can contain secrets. Rotation changes the reference. Revocation and expiry stop access.

Keep the store on trusted operator infrastructure. Give agents case input or narrow worker operations. Exclude database handles, owner-policy methods and enrollment secrets from prompts. Authenticate each role before exposing these methods over a network.

### Authorize a write

The proposal contains agent, account, action, target, canonical payload digest, currency, per-effect amount in minor units and policy version. The dispatcher calculates SHA-256 over the exact serialized payload.

A standing grant binds actor, account, action, currency, per-effect ceiling and validity window. Escalate an over-limit request to the owner. Exact one-off approval binds every request field. The store consumes it atomically with intent creation. Each decision records allow, deny or require-owner. Global, owner and account pauses take precedence.

### Reserve and reconcile funds

1. Set the aggregate limit for the business, budget reference and currency before a paid effect. For an older database, existing confirmed actions and pending reservations count toward the limit.
2. At dispatch, the store commits the intent and reservation together before calling the connector.
3. Check recipient evidence. A confirmed effect converts the reservation to a cost. Verified absence releases the reservation. Keep the reservation while the result is unknown.
4. For an eligible retry, use the original idempotency key for the same effect.

Inspect the queue, node activity, budgets, costs, owner time and redacted audit events with the owner console. [Owner console commands](../apps/console/README.md)

The standalone tests map to issue IDs. The recovery test stops a child process after the simulated recipient writes a receipt and before local confirmation. On restart the scheduler holds the task for reconciliation. The test verifies a single receipt and no duplicate dispatch.
