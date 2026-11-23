import { randomBytes } from 'node:crypto';
import { requireValue } from '../local/store.mjs';

const nonempty = (s) =>
  typeof s === 'string' && s.trim().length > 0 && s.length <= 200;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const runtimes = ['unsloth', 'tenstorrent'];

function memorySample(row, device, now) {
  requireValue(
    row?.device === device &&
      positive(row.capacityBytes) &&
      Number.isSafeInteger(row.usedBytes) &&
      row.usedBytes >= 0 &&
      row.usedBytes <= row.capacityBytes &&
      Number.isSafeInteger(row.observedAt) &&
      row.observedAt <= now &&
      now - row.observedAt <= 10000,
    'Invalid device memory sample'
  );
  return {
    usedBytes: row.usedBytes,
    capacityBytes: row.capacityBytes,
    observedAt: row.observedAt
  };
}

// Configure an explicit endpoint on the serving machine or a local forward.
// A supervisor supplies fresh, device-scoped telemetry, independent of model text.
export async function qualifyProfile(
  config,
  {
    sampleMemory,
    request = fetch,
    token,
    signal,
    clock = Date.now,
    synthetic = false
  } = {}
) {
  const {
    runtime,
    device,
    model,
    revision,
    servingVersion,
    contextSample = '',
    timeoutMs = 60000
  } = config;
  requireValue(
    runtimes.includes(runtime) &&
      [device, model, revision, servingVersion].every(nonempty),
    'Identify the runtime, serving version, device, model and model revision'
  );
  requireValue(
    typeof contextSample === 'string' &&
      contextSample.length <= 24000 &&
      positive(timeoutMs) &&
      timeoutMs <= 900000,
    'Invalid qualification bounds'
  );
  const url = new URL(config.origin);
  requireValue(
    ['http:', 'https:'].includes(url.protocol) &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.href === url.origin + '/',
    'Use a loopback serving origin'
  );
  const timeout = AbortSignal.timeout(timeoutMs),
    active = signal ? AbortSignal.any([timeout, signal]) : timeout;
  const base = {
    runtime,
    device,
    model,
    revision,
    servingVersion,
    operation: 'text',
    source: synthetic ? 'fixture' : 'measurement'
  };
  const finish = (status, detail) => ({
    ...base,
    status,
    observedAt: clock(),
    ...detail
  });
  const headers = {
    'Content-Type': 'application/json',
    ...(token && { Authorization: 'Bearer ' + token })
  };
  async function get(endpoint, body) {
    return request(url.origin + endpoint, {
      headers,
      method: body ? 'POST' : 'GET',
      ...(body && { body: JSON.stringify(body) }),
      signal: active,
      redirect: 'error'
    });
  }
  try {
    const listing = await get('/v1/models');
    if (!listing.ok) {
      await listing.body?.cancel();
      return finish('unavailable', {
        reason: 'Catalog HTTP ' + listing.status
      });
    }
    const data = (await listing.json()).data;
    requireValue(Array.isArray(data), 'Invalid catalog');
    const advertised = data.find((row) => row.id === model);
    if (!advertised)
      return finish('unsupported', {
        reason: 'Model missing from serving catalog'
      });
    if (advertised.loaded === false)
      return finish('unavailable', { reason: 'Model is unloaded' });
    if (advertised.digest && advertised.digest !== revision)
      return finish('unverified', { reason: 'Model revision changed' });
    let before, after;
    try {
      before = memorySample(
        await sampleMemory?.(device, active),
        device,
        clock()
      );
    } catch {
      return finish('unverified', {
        reason: 'Fresh device memory measurement is required'
      });
    }
    const challenge = 'P' + randomBytes(5).toString('hex');
    const start = performance.now();
    const response = await get('/v1/chat/completions', {
      model,
      messages: [
        {
          role: 'user',
          content: contextSample + '\nReply with exactly ' + challenge
        }
      ],
      temperature: 0,
      stream: false,
      max_tokens: 48
    });
    if (!response.ok) {
      await response.body?.cancel();
      return finish(
        response.status === 405 || response.status === 501
          ? 'unsupported'
          : 'unavailable',
        { reason: 'Text probe HTTP ' + response.status }
      );
    }
    const reply = await response.json(),
      elapsedMs = Math.max(1, Math.ceil(performance.now() - start));
    if (
      reply?.model !== model ||
      reply.choices?.[0]?.message?.content?.trim() !== challenge ||
      reply.choices[0].finish_reason !== 'stop'
    )
      return finish('unverified', {
        reason: 'Model identity or task result did not match'
      });
    if (
      !positive(reply.usage?.prompt_tokens) ||
      !positive(reply.usage?.completion_tokens) ||
      reply.usage.completion_tokens > 48
    )
      return finish('unverified', {
        reason: 'Missing or invalid token measurements'
      });
    try {
      after = memorySample(await sampleMemory(device, active), device, clock());
    } catch {
      return finish('unverified', {
        reason: 'Final device memory measurement is required'
      });
    }
    if (
      before.capacityBytes !== after.capacityBytes ||
      after.observedAt < before.observedAt
    )
      return finish('unverified', { reason: 'Inconsistent device telemetry' });
    active.throwIfAborted();
    return finish('qualified', {
      inputTokens: reply.usage.prompt_tokens,
      outputTokens: reply.usage.completion_tokens,
      elapsedMs,
      outputTokensPerSecond: (reply.usage.completion_tokens * 1000) / elapsedMs,
      memory: { before, after }
    });
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    return finish('unavailable', {
      reason: timeout.aborted
        ? 'Qualification timed out'
        : 'Serving transport or response unavailable'
    });
  }
}

// Fresh health is supplied by the scheduler. A later failed probe supersedes
// an earlier success, even when a caller retains multiple matrix observations.
export function routes(
  matrix,
  {
    model,
    revision,
    inputTokens,
    outputTokens,
    operation = 'text',
    online,
    now = Date.now(),
    maxAgeMs = 3600000,
    synthetic = false
  }
) {
  requireValue(
    Array.isArray(matrix) &&
      Array.isArray(online) &&
      positive(inputTokens) &&
      positive(outputTokens) &&
      positive(maxAgeMs) &&
      Number.isSafeInteger(now),
    'Invalid routing constraints'
  );
  const latest = new Map();
  for (const row of matrix) {
    if (
      row.model !== model ||
      row.revision !== revision ||
      row.operation !== operation ||
      row.source !== (synthetic ? 'fixture' : 'measurement')
    )
      continue;
    const key = JSON.stringify([row.runtime, row.device]);
    if (!latest.has(key) || latest.get(key).observedAt <= row.observedAt)
      latest.set(key, row);
  }
  return [...latest.values()]
    .filter(
      (r) =>
        r.status === 'qualified' &&
        r.observedAt <= now &&
        now - r.observedAt <= maxAgeMs &&
        r.inputTokens >= inputTokens &&
        r.outputTokens >= outputTokens &&
        online.some(
          (n) =>
            n.device === r.device &&
            n.runtime === r.runtime &&
            n.servingVersion === r.servingVersion &&
            n.revision === r.revision &&
            n.model === r.model
        )
    )
    .sort(
      (a, b) =>
        b.outputTokensPerSecond - a.outputTokensPerSecond ||
        a.device.localeCompare(b.device)
    );
}
