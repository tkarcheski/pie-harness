# Architecture

The planned control plane uses TypeScript and the owner console uses React. Temporal executes durable workflows. PostgreSQL stores business records using logical databases and roles separated from Temporal. Node supervisors can invoke Python executors for inference and media dependencies. Begin with managed local artifact storage, followed by an S3-compatible adapter. Evaluate OpenBao as the first external secrets manager. Compose is the initial deployment model.

Opportunity → Experiment → Workflow run → Task → Attempt is the domain hierarchy. Use economic evidence to prioritize opportunities and verified execution capabilities to route tasks. Surface node, agent, task, workflow, and channel status with explicit deadlines, budgets, retries, and stopping conditions.

Agents propose actions. Deterministic services enforce account scope, authority, budgets, and external effects. Agents cannot expand their grants or approve their own exceptions. External writes require persisted intents and atomic budget reservations. Use idempotency where available and reconcile unknown outcomes before retrying. Separate bank observation, transaction preparation, money movement, and administrative changes.

Track liquidation proceeds separately from recurring income. Keep forecasts, actual monetary contribution, and owner time separate. Measure maintenance and growth using outcome evidence. Legal operations track sources, reviews, rights, obligations, and renewal dates.
