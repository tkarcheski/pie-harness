# Architecture

## Current distribution

A single-host SQLite store runs the local task queue. Workers claim tasks, record attempts and produce artifacts. The business hierarchy is opportunity → experiment → workflow run → task → attempt. Economic evidence guides the choice of opportunity. Verified execution capabilities determine which worker can take a task. [Local control plane](local-core.md)

Show the state of each node, agent, task, workflow and channel. Include the deadline, budget, retry limit and stop condition. Track forecasts, actual monetary contribution and owner time separately. Record liquidation proceeds separately from recurring income. Use observed outcomes to evaluate maintenance and growth. For legal work, retain the source, review, rights, obligation and renewal date.

## Authority

Agents propose actions. Deterministic services check the account, authority and budget. Only the owner can expand a grant or approve an exception. Before an external write, persist the intent and reserve its budget atomically. Use idempotency when the recipient supports it. If the result is unknown, check recipient evidence before retrying. Keep bank observation, transaction preparation, money movement and administration separate.

## Planned deployment

The design calls for a TypeScript control plane, a React owner console and Temporal workflows. PostgreSQL would store business and Temporal data in separate logical databases with separate roles. Node supervisors would invoke Python executors for inference and media.

The first deployment design uses Compose and managed local artifact storage. Later work includes an S3-compatible artifact adapter and evaluation of OpenBao as an external secrets manager.
