# Adapter boundaries

- Model providers expose qualified inference profiles. Start with Ollama and qualify Unsloth serving profiles independently.
- Agent runtimes manage bounded sessions, task handoffs, cancellation, and artifact references. Hosted integrations use supported account access.
- Hardware resources expose verified capabilities, availability, and limits. A Tenstorrent executor is planned.
- External-service connectors report execution capabilities and idempotency support. The control plane authorizes effects and reconciles unknown outcomes.

The Studio uses `OllamaProvider` to inspect installed model metadata and send chat requests to the loopback Ollama service. Run `node apps/studio/cli.mjs --model-info MODEL` to see a model's reported format and capabilities without generating a response. Older servers may omit the capability list. The separate `SingleTurnRuntime` accepts a provider and caller cancellation signal, bounds the turn, and passes cancellation to the provider. Task-level evaluation measures whether a model completes the required work. See [Ollama model details](https://docs.ollama.com/api-reference/show-model-details).

Keep adapter credentials out of requests and fixtures. Use synthetic conformance tests for capability mismatches, timeouts, ambiguous effects, and cancellation.
