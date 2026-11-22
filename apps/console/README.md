# Local owner console

From the standalone checkout, pass commands to an initialized Studio directory using `node apps/studio/cli.mjs STATE_DIRECTORY owner INPUT.json`. Use `-` to read JSON from standard input. The local owner console uses the business and owner associated with that directory.

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

To inspect the queue, save `{"command":"queue"}` as the input file. To see alert IDs or inspect a budget, use `{"command":"audit"}`. These commands assume the operator already has trusted workstation access.
