# Standalone release checklist

## First checkout

Install Node.js 22.13 or later with its bundled SQLite module. Clone the distribution into an empty directory. From its root run the following commands. The suite uses local fixtures and requires no account or cloud credentials.

~~~sh
node apps/control-plane/local.mjs
node --test "tests/*.test.mjs"
node apps/connectors/conformance.mjs
node apps/resale/rehearsal.mjs
~~~

For the studio experiment, choose a new runtime directory outside Git and follow [channel operations](channel-ops.md). The optional media renderer requires a local FFmpeg binary with PNG and H.264 support. Hosted jobs and private chat require the owner's separately installed connection. [Runtime adapters](adapters.md)

## Trust boundaries

| Boundary | Assumption and control |
| --- | --- |
| Owner and host | Owner commands run inside a trusted local process. The embedding app authenticates the caller and chooses the owner identity. Anyone with access to the runtime database or worker enrollment keys is inside this boundary. Restrict filesystem access, use encrypted storage for sensitive operations and protect backup copies as credentials. |
| Workers and model output | Enrollment, capability probes, task leases and fence tokens constrain the queue. Treat generated work as a proposal. Validate its fields and check current scoped authority before an external action. Queue fencing protects persisted transitions. It cannot recall a request that already reached a provider. |
| Accounts and providers | Keep secret values in the owner-controlled secret provider. Store only opaque references in the registry. Check scope, expiry, pausing and containment when using an account. Review the proposal digest, business, actor, amount, currency and deadline. Inspect ownership and rights outside the model. |
| External effects | A recipient must implement a stable identity for each write, or supply a verified equivalent. Persist an intent before dispatch. Reconcile a missing response with recipient evidence; an ambiguous result remains pending for review. Callbacks and imported observations are untrusted and must be validated and deduplicated. |
| Evidence and state | Synthetic fixtures belong in tests. Keep operational databases, transcripts, account data, statements, product source material, generated assets and receipts in restricted runtime storage. The database is a single-host durability boundary. Back it up with its enrollment material and verify restoration on fresh storage. |

## Release review

1. Build the candidate from the reviewed distribution allowlist in the source workspace. Inspect changed paths, file modes, imports, examples, dependency changes and hosted workflow permissions. Exclude local runtime state at this step.
2. Apply the candidate on a branch from the previous public main commit in the independent distribution history. Compare the entire staged tree with the candidate. Record the full commit ID.
3. Re-clone the proposed distribution and run the first-checkout commands. Exercise the studio, cancellation, ambiguous-effect recovery, scoped revocation and a snapshot restore. Keep real wall-clock recovery measurements separate from fast CI tests. [Operated drill](recovery-drill.md)
4. Run the standalone test matrix on Linux and Windows. Review both jobs at the proposed head. After merge verify the resulting tree against the same allowlist and retain the merge hash, CI link, result counts and remaining gaps in the release record.

## Qualification and operating limits

A profile becomes available for routing only after it satisfies the probe and capacity requirements. Physical accelerator and Unsloth measurements depend on access to the designated equipment. Each deployment needs its own measurements. [Qualification procedure](connectors-profiles.md)

The eBay adapter targets the Sandbox. The portable settlement desk consumes read-only observations supplied by the operator. The internal content experiment measures a generated edition against stated criteria. A live listing, purchase, publication or paid pilot requires an authorized account and a separate owner decision. [Resale desk](resale.md) · [Channel experiments](channel-ops.md)

Report a suspected vulnerability through the [private reporting procedure](../SECURITY.md).
