# Operated recovery drill

## Start a timed drill

Use Node.js 22.13 or later. From the distribution root, run `node apps/recovery/drill.mjs 30` for a 30-minute wall-clock drill. The maximum duration is 60 minutes. A missed target causes an unsuccessful exit. For the short CI check, run `node --test tests/recovery-drill.test.mjs`.

## Check the sequence

1. A worker subprocess persists an artifact checkpoint. The operator terminates the worker during its lease. A second enrolled node recovers the checkpoint and completes the task. The old worker's attempt to complete it must fail. Children also terminate on IPC disconnect or when their fifteen-second watchdog expires.
2. Studio queues a synthetic product draft. The drill places a consistent SQLite snapshot, its matching enrollment key, and a SHA-256 manifest in a separate backup directory. It checks SQLite integrity and verifies that the active enrollment matches the key before writing the manifest.
3. The drill removes its disposable source directory, including the original key, database, and maintenance snapshot. It opens a fresh Studio from the bundle alone. The restored worker must complete the previously queued product task and produce the expected draft in review. The journal records the task ID and draft digest.
4. The restored queue runs until the requested duration elapses. The journal records periodic progress and reconciles the exact number of completed tasks. Final JSON includes the journal path, bundle path, timings, and database integrity result.

## Protect the results

Each drill creates a fresh OS temporary directory. On POSIX, private directories use mode `0700` and bundled files use `0600`. On Windows, the temporary root, backup and restore directories have an inheritable access rule for the current account. Protect backup and restore directories as credentials. Redact the report before sharing it.

Recovery stops for a missing manifest, changed snapshot, mismatched or revoked enrollment, or an occupied restore destination. Use a fresh destination to retry.

## Interpret the timings

The drill uses a 1.2-second lease and a three-second heartbeat window. It checks two 15-second targets. The first runs from worker loss to replacement completion. The second covers backup creation and draft production in the restored Studio.

The drill uses a local fixture model and same-host storage. For host-loss testing, measure the age of the latest usable off-machine backup. Time a restore with your own data volume and storage. [Studio maintenance](local-operations.md)
