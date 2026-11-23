import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyProfile, routes } from '../packages/connectors/profiles.mjs';

const config = {
  runtime: 'unsloth',
  device: 'fixture-gpu',
  model: 'fixture-text',
  revision: 'fixture-v1',
  servingVersion: '1.0',
  origin: 'http://127.0.0.1:8080'
};
function harness(c = config) {
  const calls = [];
  return {
    calls,
    synthetic: true,
    clock: () => 10000,
    sampleMemory: () => ({
      device: c.device,
      usedBytes: 400,
      capacityBytes: 1000,
      observedAt: 9999
    }),
    request: async (url, init) => {
      calls.push(url);
      if (url.endsWith('/models'))
        return Response.json({
          data: [{ id: c.model, digest: c.revision, loaded: true }]
        });
      const body = JSON.parse(init.body);
      return Response.json({
        model: body.model,
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: body.messages[0].content.match(/P[a-f0-9]{10}$/)[0]
            }
          }
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5 }
      });
    }
  };
}
test('PIE-023 limits use fresh model, device memory, endpoint and token evidence', async () => {
  const h = harness(),
    q = await qualifyProfile(config, h);
  assert.equal(q.status, 'qualified');
  assert.equal(q.memory.after.capacityBytes, 1000);
  assert.equal(q.outputTokens, 5);
  const job = {
    model: config.model,
    revision: config.revision,
    inputTokens: 20,
    outputTokens: 5,
    now: 10001,
    online: [config],
    synthetic: true
  };
  assert.deepEqual(routes([q], job), [q]);
  for (const changes of [
    { inputTokens: 21 },
    { outputTokens: 6 },
    { operation: 'embedding' },
    { online: [] },
    { synthetic: false },
    { now: 9999 },
    { maxAgeMs: 1, now: 10002 },
    { online: [{ ...config, servingVersion: '2.0' }] }
  ])
    assert.deepEqual(routes([q], { ...job, ...changes }), []);
  const missing = harness();
  missing.sampleMemory = () => ({ observedAt: 0, usedBytes: 8 });
  assert.equal((await qualifyProfile(config, missing)).status, 'unverified');
  assert.equal(missing.calls.length, 1);
  const auth = harness();
  auth.request = async () => new Response('sensitive content', { status: 401 });
  assert.deepEqual(
    (await qualifyProfile(config, auth)).reason,
    'Catalog HTTP 401'
  );
  await assert.rejects(
    qualifyProfile({ ...config, origin: 'https://public.example' }, h),
    /loopback/
  );
});
test('PIE-024 newer unavailable accelerator evidence routes to a separately qualified device', async () => {
  const tt = { ...config, runtime: 'tenstorrent', device: 'fixture-wormhole' },
    a = await qualifyProfile(config, harness()),
    b = await qualifyProfile(tt, harness(tt));
  const down = await qualifyProfile(tt, {
    ...harness(tt),
    clock: () => 10001,
    request: () => {
      throw Error('offline');
    }
  });
  const unsupported = await qualifyProfile(
    { ...tt, model: 'other' },
    harness(tt)
  );
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(down.status, 'unavailable');
  const job = {
    model: config.model,
    revision: config.revision,
    inputTokens: 8,
    outputTokens: 2,
    online: [config, tt],
    synthetic: true,
    now: 10002
  };
  assert.deepEqual(routes([a, down, b, unsupported], job), [a]);
  assert.deepEqual(routes([a, b], { ...job, online: [tt] }), [b]);
});
