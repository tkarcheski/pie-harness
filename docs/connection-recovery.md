# Connection incidents and recovery

On a trusted workstation, run the Studio owner command against its state directory. Pass a JSON file after the command or a dash for standard input. Each command operates on the registered owner of that studio.

| Command field | Other JSON fields | Result |
| --- | --- | --- |
| connection-expiry | Optional horizonMs, up to 30 days | Accounts and grants due within the window, including expired entries. Daily studio maintenance runs the default one-day check. The owner audit holds the resulting alerts. |
| connection-suspend | account, id, reason, evidenceDigest | Immediately contains the account. Choose credential-exposure, unexpected-access or connector-failure. Use an incident identifier and SHA-256 digest of evidence held by the operator. |
| connection-approve-restore | account, id, reviewDigest, expiresAt | Records the owner's decision for that specific incident and credential revision. Supply an absolute expiry in milliseconds within the next 15 minutes. |
| connection-restore | account, id, reviewDigest | Consumes the matching approval, records the restoration and resolves its alert. Other open incidents, revocations and paused scopes still apply. |

Run with `node apps/studio/cli.mjs STATE_DIRECTORY owner INPUT.json`. The trusted caller supplies the owner identity. Store original incident evidence with restricted access outside the project. The audit records reason codes, timestamps, account IDs and evidence digests. Rotating credentials or opening another incident invalidates outstanding restoration approvals. If a connector already sent a request, inspect its recipient receipt through the reconciliation workflow.
