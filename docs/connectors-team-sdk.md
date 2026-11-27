# Teams and connector conformance

## Test the connector

Run `node apps/connectors/conformance.mjs` from the distribution root. It exercises the built-in recipient. To test another connector, pass the path to its isolated fixture module. A contract mismatch returns an unsuccessful exit status. [Version 1 SDK](../packages/connectors/sdk.mjs)

1. Export `fixtureConnector({fault})`. Each call must return a fresh recipient. Set manifest `version: 1`, the platform name from account registration, and `idempotency: 'recipient-key'`.
2. Implement asynchronous `send(bytes, {intent, idempotencyKey, signal})` and `reconcile(key, {signal})`. Reusing a key with the same bytes must return one effect and one stable receipt. Reject the same key with different bytes.
3. For verified recipient evidence, return `{state:'confirmed'|'absent', reference}`. Return `{state:'unknown'}` for an uncertain result. Use bounded opaque IDs for receipt and evidence references.

4. Implement `countEffects()` on the recipient. Exercise `none`, `before-write` and `after-write`. These modes cover success, interruption before dispatch and a lost acknowledgment after a write. Keep fixture traffic local.
5. For an authorized effect, pass `connectorV1(adapter)` to `dispatchEffect`. Resolve an uncertain attempt with `reconcileEffect(engine, owner, taskId, adapter)`. Reconciliation verifies the original platform and intent before committing the update.

Recipient lookup uses the original action's account scope. The SDK checks access before lookup and checks the same credential revision at commit. If access changes, leave the effect pending for authorized reconciliation.

## Planner, executor and reviewer

1. Call `submitTeam(store, owner, spec)` with a stable submission key, run ID, budget reference, input artifact reference and three assignments.
2. Bind the existing agent and separately enrolled node for each role. All three instances can run on one machine. Probe each worker for `team.ROLE.NODE_ID`.
3. Set one to four attempts. Each task keeps the original run deadline. The job limit is one hour.

4. Claim the work using `Execution.claim`. Read input and upstream artifact references with `teamPacket`, the current worker token and fence.
5. Complete each stage with `completeStage`. Supply the output reference and its SHA-256 digest. The store commits the handoff and task completion together.
6. Have the reviewer record `accept` or `return`. Returned work stays in the run history. The owner can start another bounded run with revised inputs.

Review decisions grant no publishing or account rights. Keep the local store, grant controls and completion API on a trusted host. [Team implementation](../packages/connectors/team.mjs) · [Team tests](../tests/connectors-team-sdk.test.mjs)
