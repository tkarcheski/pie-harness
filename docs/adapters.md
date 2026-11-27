# Adapter responsibilities

| Adapter | Responsibility |
| --- | --- |
| Model provider | Report the serving model and qualified profile. Start with Ollama. Qualify each Unsloth deployment independently. |
| Agent runtime | Bound each session, pass cancellation to the provider and return handoff or artifact references. Use supported sign-in for hosted accounts. |
| Hardware resource | Report measured capabilities, availability and limits. A Tenstorrent executor is planned. |
| External service | Report supported actions and idempotency. The control plane authorizes writes and reconciles uncertain outcomes. |

## Inspect a local model

Run `node apps/studio/cli.mjs --model-info MODEL` with the installed Ollama model tag. The command asks the loopback service for model metadata. It reports the format and any capabilities that the server returns. Older servers can omit capabilities. [Ollama model details](https://docs.ollama.com/api-reference/show-model-details)

`SingleTurnRuntime` accepts a provider and a caller cancellation signal. It bounds the turn and forwards the signal. Use a task-level evaluation to check whether the model can complete the work.

Keep credentials outside request payloads and fixtures. Test capability mismatches, timeouts, uncertain writes and cancellation with synthetic recipients.
