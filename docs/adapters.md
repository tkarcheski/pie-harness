# Adapter boundaries

- Model providers expose qualified inference profiles. Start with Ollama and qualify Unsloth serving profiles independently.
- Agent runtimes manage bounded sessions, task handoffs, cancellation, and artifact references. Hosted integrations use supported account access.
- Hardware resources expose verified capabilities, availability, and limits. A Tenstorrent executor is planned.
- External-service connectors report execution capabilities and idempotency support. The control plane authorizes effects and reconciles unknown outcomes.

Keep adapter credentials out of requests and fixtures. Use synthetic conformance tests for capability mismatches, timeouts, ambiguous effects, and cancellation.
