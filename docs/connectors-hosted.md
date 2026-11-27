# Hosted text turns

## Select the provider account

Use an owner-authorized OpenAI API project key and a model that supports Responses background mode. The provider stores the response for retrieval. Check the provider's retention terms before submitting sensitive material. This adapter bills the API project. Coding-tool subscriptions use their own native sign-in. [Provider background execution and cancellation](https://developers.openai.com/api/docs/guides/background)

1. Register an `openai-responses` account in the local registry. Supply an opaque secret reference and the `hosted.turn`, `hosted.observe` and `hosted.cancel` scopes.
2. Construct `HostedResponses` with a trusted secret resolver. Set the business budget. Give the actor a time-limited standing grant or obtain exact owner approval.
3. Serialize the model ID, prompt and maximum output tokens with `serializeTurn(spec)`. Use its digest for exact approval. Bind the approval's object to the model ID. Set its amount to the owner's charge ceiling. Reconcile the actual provider bill separately.

## Run and supervise a turn

1. Claim a local task with an original deadline of at most one hour. Call `runtime.submit(owner, task, worker, proposal, spec)`. The engine reserves the budget before dispatch. The provider receives bounded text and an empty tools list.
2. Call `runtime.supervise(owner, task)` on the trusted supervisor's regular tick. The submission task records acceptance. Downstream workers must check the hosted status before taking the result. At the deadline, a running supervisor requests cancellation. After supervisor downtime, check remote status on restart.
3. Authenticate incoming webhook traffic. Pass a verified event to `runtime.refresh(owner, task, {eventId, responseId})`. The adapter retrieves the response and checks the submission metadata. Duplicate events return the recorded state. If the create response is uncertain, keep the task pending. Verify the response ID or confirm with the provider that it has no job.
4. For an early stop, call `runtime.cancel(owner, task)`. For a completed turn, use `runtime.result(owner, task)` to retrieve verified text. Save the result in a private artifact destination. The audit stores the output digest and opaque IDs. Keep credentials, prompts, answers and provider error bodies outside audit state.
5. To stop further calls, pause or revoke the account. If possible, cancel pending jobs before revoking the key. A remote job can require intervention through the provider account after revocation.

The adapter checks the active credential revision after each provider response. It checks before accepting a receipt or releasing text. If the account changed during the call, perform a fresh authorized read.

The standalone tests use an in-memory recipient. They check approval, lost acknowledgments, cancellation, revocation, verified output and duplicate callbacks. [Adapter](../packages/connectors/hosted.mjs) · [Lifecycle tests](../tests/connectors-hosted.test.mjs)
