# Controlled local execution

The single-host implementation uses Node.js 22.13+ and its SQLite driver. Start with `node apps/control-plane/local.mjs`. It validates the versioned configuration before opening a database, enrolls a synthetic worker, executes one task and reports its verified checkpoint. All connectors are disabled. Pass a configuration filename or set PIE_CONFIG. The positional filename takes precedence. Set PIE_STATE_DB to a filesystem path outside the checkout for persistence. The default proof uses an in-memory store.

## Records and migration

The store distinguishes owner, business, persona, agent, external account, channel, opportunity, experiment, run, task, attempt, action and artifact. Every record has a stable UUID, owner, UTC epoch-millisecond creation time and version. Parent references are type- and owner-checked. Attempts reference their task and node. Artifacts reference the producing attempt. The forecast lives on the opportunity. The task references its experiment and budget. Unknown channel economics may remain unset. An estimate uses minor-unit ranges, currency, horizon, review date and evidence references.

The single-host backend keeps a transactional state document in SQLite. BEGIN IMMEDIATE serializes competing writers. User version 1 migrations preserve execution records while adding policy, approval and intervention collections in version 2. This design targets a small local workspace. A replicated service or high-throughput deployment needs a separately reviewed persistence and authentication design.

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

A worker heartbeat reports health. A trusted supervisor records versioned capability probe evidence. Enrollment supplies a revocable node ID and secret token; the database holds its hash. The scheduler excludes unhealthy, stale, draining, unqualified and full nodes. Renewals stay inside the last heartbeat's freshness window. Recovery reaps expired claims before dispatch and returns the prior artifact reference under a new fence. A stale worker cannot commit, even if it resumes after replacement.

## Account and authority boundary

The owner registers platform, owner, recovery owner, action scopes, expiry and an opaque secret reference. The development provider keeps synthetic values in memory; an operator-selected vault adapter implements async resolve(reference) and supplies the value only to a trusted connector. The account probe exposes a boolean result. It suppresses secret-bearing provider exceptions and creates actionable intervention records. Rotation changes the reference. Revocation and expiry stop access.

The local store is trusted operator infrastructure. Agents receive case input or narrow worker operations. Keep database handles, owner-policy methods, and node enrollment secrets out of agent prompts. A future network service must authenticate those roles before exposing any methods.

Effect proposals declare the agent, account, action, target object, canonical payload digest, currency, per-effect minor units and policy version. The dispatcher checks the SHA-256 digest of the exact serialized payload. Standing grants bind actor, account, action, currency, per-effect ceiling and validity window. An over-limit request requires owner escalation. An exact one-off approval binds all request fields and is consumed atomically when the intent is created. Every decision records allow, deny or require-owner. Global, owner and account pauses take precedence.

Before a paid effect can run, the owner sets an aggregate limit for its business, budget reference and currency. Dispatch commits the pending intent and reservation in one transaction before calling the connector. Confirming recipient evidence converts that reservation to a cost. An unknown outcome holds the reservation until the recipient can be checked. A verified absence releases it. If the task can retry, the same proposed effect carries its original idempotency key. Existing confirmed actions and pending reservations count toward the limit when an owner configures a budget on an older database.

The [owner console commands](../apps/console/README.md) expose the queue, node activity, budgets, costs, owner time and redacted audit events.

The public tests correspond to the issue IDs. The recovery test kills a child after a simulated recipient writes a receipt and before local confirmation. On restart the scheduler withholds that task until reconciliation. The test verifies one receipt and no repeat dispatch.
