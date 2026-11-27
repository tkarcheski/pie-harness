# Connection incidents and recovery

## Inspect the account

Use a trusted owner process on the workstation. Run `node apps/studio/cli.mjs STATE_DIRECTORY owner INPUT.json`. Put the command and its fields in the JSON file. Use `-` for standard input. The registered owner controls the account.

| Command field | Other JSON fields | Result |
| --- | --- | --- |
| connection-expiry | Optional horizonMs, up to 30 days | Accounts and grants due within the window, including expired entries. Daily studio maintenance runs the default one-day check. The owner audit holds the resulting alerts. |
| connection-suspend | account, id, reason, evidenceDigest | Immediately contains the account. Choose credential-exposure, unexpected-access or connector-failure. Use an incident identifier and SHA-256 digest of evidence held by the operator. |
| connection-approve-restore | account, id, reviewDigest, expiresAt | Records the owner's decision for that specific incident and credential revision. Supply an absolute expiry in milliseconds within the next 15 minutes. |
| connection-restore | account, id, reviewDigest | Consumes the matching approval, records the restoration and resolves its alert. Other open incidents, revocations and paused scopes still apply. |

## Restore access

1. Store the incident evidence outside the project with restricted access. Record its SHA-256 digest.
2. Suspend the affected account. The audit records the account ID, reason, timestamps and evidence digest.
3. Review the incident and the current credential revision. Approve restoration for that incident. Rotating the credential or opening another incident invalidates the approval.
4. Restore the account before the approval expires. Inspect any remaining incidents, revoked grants or paused scopes.
5. If a connector sent a request before suspension, use the reconciliation workflow to check the recipient's receipt.
