# Measure a model on its serving device

## Run the probe

Run `node apps/connectors/qualify.mjs PROFILE.json TELEMETRY.json` on the serving machine or through a loopback forward. The command sends one bounded text request to a model in the server catalog. It prints one JSON row for the operator's capability matrix. Exit code 2 means the model did not qualify. Save the measurements outside the checkout.

1. Set `runtime` to `unsloth` or `tenstorrent`. Specify the `device`, `model`, `revision`, `servingVersion` and loopback `origin`.
2. Get the artifact revision and serving build from the deployment record. A catalog digest must match the deployed digest. To exercise the intended input size, supply `contextSample`.
3. If the service requires a key, set `PIE_LOCAL_SERVING_KEY`. The probe uses the OpenAI-compatible catalog and chat completions endpoints. [Unsloth inference](https://unsloth.ai/docs/basics/inference-and-deployment) · [Tenstorrent inference server](https://github.com/tenstorrent/tt-inference-server)

4. Run the telemetry collector on the inference host. Replace the telemetry file atomically. Include `device`, `usedBytes`, `capacityBytes` and `observedAt` in UTC epoch milliseconds.
5. Select the memory domain for the deployment, such as accelerator DRAM. Record the metric source. Both samples must be at most ten seconds old. To measure peak memory between samples, use a continuous sampler.

## Read the result

The probe checks model identity, a fresh challenge, token counts, memory and wall-clock throughput. A passing row covers the tested operation, input size and output size. A missing catalog model produces an unsupported row. Other failure reasons include an unavailable service, denied access, missing telemetry and a failed challenge. Repeat the probe for each build, device, model revision and representative input.

Call `routes(matrix, job)` with the current online devices, model revisions and serving versions. The newest probe for a matching deployment takes precedence. If a preferred device goes offline, a fresh compatible deployment can take the job. If none qualify, the job stays pending.

Fixtures use `source: fixture`. Normal routing uses measured rows. Verify device limits, unsupported operations and speed on the actual deployment. [Qualification and routing](../packages/connectors/profiles.mjs)
