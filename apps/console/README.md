# Local owner console

Use the local owner console from a trusted workstation. The command operates on the business and owner registered in the Studio state directory.

1. Initialize a Studio directory.
2. Save the command and its fields in a JSON file.
3. Run `node apps/studio/cli.mjs STATE_DIRECTORY owner INPUT.json` from the distribution root. Use `-` in place of the file to read standard input.

| JSON command | Additional fields | Result |
| --- | --- | --- |
| `queue` | None | Prioritized tasks, blocking reasons, dependencies, last progress, pending intents and worker activity |
| `audit` | None | Redacted events, costs by currency, owner minutes, budget balances and alerts |
| `budget` | `ref`, `currency`, `limitMinor` | Sets the total limit in minor currency units and returns available funds |
| `rank` | `task`, `priority` | Changes priority for a waiting task. Higher integers run first |
| `time` | `task`, `minutes`, `entryId` | Records positive whole minutes. Reuse the same entry ID when repeating a submission |
| `ack` | `id` | Acknowledges an active alert |
| `retry` | `task`, `maximumAttempts` | Authorizes one more attempt after a failure, subject to the original deadline, dependencies and pauses. Use the current attempt count plus one |
| `cancel` | `task` | Stops future dispatch. An uncertain effect still needs recipient evidence |
| `reconcile` | `task`, `intent`, `confirmed`, `evidence` | Records a confirmed receipt or verified absence for the current intent. Use an opaque evidence reference |

For example, save `{"command":"queue"}` to inspect waiting work. To find alert IDs or check a budget, use `{"command":"audit"}`.
