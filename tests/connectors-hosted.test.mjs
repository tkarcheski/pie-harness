import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Accounts,
  OwnerPolicy,
  DevelopmentSecrets,
  payloadDigest
} from '../packages/local/authority.mjs';
import { Store } from '../packages/local/store.mjs';
import { changeIncident } from '../packages/local/connections.mjs';
import { Execution } from '../packages/local/execution.mjs';
import { setBudget } from '../packages/local/operations.mjs';
import { sampleDomain } from '../apps/control-plane/local.mjs';
import {
  HostedResponses,
  serializeTurn
} from '../packages/connectors/hosted.mjs';
import { reconcileEffect } from '../packages/connectors/sdk.mjs';

function setup(t, { lose = false } = {}) {
  const time = { now: 100 };
  const store = new Store(':memory:', () => time.now);
  t.after(() => store.close());
  const { owner, business, run, actor } = sampleDomain(store);
  const engine = new Execution(store, { leaseMs: 6000, heartbeatMs: 6000 });
  const worker = engine.enroll(owner);
  engine.probe(owner, worker.node, {
    name: 'hosted',
    version: '1',
    state: 'supported',
    evidence: 'fixture'
  });
  engine.heartbeat(worker, true);
  const task = engine.enqueue(owner, {
    run,
    actor,
    capability: 'hosted',
    budgetRef: 'test',
    deadline: 1000,
    retryLimit: 1
  }).id;
  const session = { ...worker, fence: engine.claim(worker).fence };
  const accounts = new Accounts(store),
    secrets = new DevelopmentSecrets(),
    secret = 'never-persist-fixture-token';
  secrets.set('secret-ref:fixture', secret);
  const account = accounts.register(owner, {
    business,
    recoveryOwner: owner,
    platform: 'openai-responses',
    secretRef: 'secret-ref:fixture',
    expiresAt: 9000,
    scopes: ['hosted.turn', 'hosted.observe', 'hosted.cancel']
  }).id;
  setBudget(store, owner, {
    business,
    ref: 'test',
    currency: 'USD',
    limitMinor: 10
  });
  const spec = {
    model: 'synthetic',
    input: 'private prompt bytes',
    maxOutputTokens: 128
  };
  const authority = {
    actor,
    account,
    action: 'hosted.turn',
    object: spec.model,
    digest: payloadDigest(serializeTurn(spec)),
    amountMinor: 5,
    currency: 'USD',
    policyVersion: 1
  };
  const grant = () =>
    new OwnerPolicy(store).grant(owner, {
      actor,
      account,
      action: 'hosted.turn',
      limitMinor: 5,
      currency: 'USD',
      validFrom: 100,
      expiresAt: 5000
    });
  const api = { calls: [], status: 'queued', intent: null };
  const runtime = new HostedResponses(engine, secrets, {
    request: async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer ' + secret);
      assert.equal(init.redirect, 'error');
      api.calls.push([url, init.method]);
      if (url === 'https://api.openai.com/v1/responses') {
        assert.equal(init.method, 'POST');
        const body = JSON.parse(init.body);
        api.intent = body.metadata.pie_intent;
        assert.deepEqual(body.tools, []);
        assert.equal(body.max_output_tokens, 128);
        if (lose) throw Error('private provider detail: ' + secret);
      }
      if (url.endsWith('/cancel')) api.status = 'cancelled';
      const response = Response.json({
        id: 'resp_fixture',
        metadata: { pie_intent: api.intent },
        status: api.status,
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'private answer' }]
          }
        ],
        internal: 'never-persist-provider-detail'
      });
      return {
        ok: true,
        async json() {
          const body = await response.json();
          api.duringRead?.();
          return body;
        }
      };
    }
  });
  return {
    store,
    owner,
    engine,
    task,
    session,
    accounts,
    account,
    spec,
    authority,
    grant,
    api,
    time,
    runtime,
    submit: () => runtime.submit(owner, task, session, authority, spec)
  };
}
test('PIE-030 grant and budget gate dispatch; observance, callback replay and revocation are scoped and redacted', async (t) => {
  const f = setup(t);
  assert.equal((await f.submit()).decision, 'deny');
  assert.equal(f.api.calls.length, 0);
  f.grant();
  assert.equal((await f.submit()).status, 'confirmed');
  await f.submit();
  assert.equal(f.api.calls.length, 1);
  f.api.status = 'completed';
  const event = { eventId: 'evt_finished', responseId: 'resp_fixture' };
  const refresh = () => f.runtime.refresh(f.owner, f.task, event);
  assert.equal((await refresh()).status, 'completed');
  await refresh();
  assert.equal(f.api.calls.length, 2);
  assert.equal(await f.runtime.result(f.owner, f.task), 'private answer');
  await assert.rejects(
    f.runtime.refresh(f.owner, f.task, { ...event, responseId: 'resp_wrong' }),
    /original/
  );
  assert.doesNotMatch(
    JSON.stringify(f.store.read()),
    /never-persist|private prompt bytes|private answer/
  );
  const incident = {
    id: 'fixture',
    account: f.account,
    reason: 'connector-failure',
    evidenceDigest: payloadDigest('evidence'),
    reviewDigest: payloadDigest('review'),
    expiresAt: 900
  };
  const act = (cmd) =>
    f.store.change((s, now) => changeIncident(s, f.owner, cmd, incident, now));
  act('connection-suspend');
  await assert.rejects(refresh, /scope unavailable/);
  act('connection-approve-restore');
  await assert.rejects(refresh, /scope unavailable/);
  act('connection-restore');
  assert.equal((await refresh()).status, 'completed');
  f.accounts.revoke(f.owner, f.account);
  await assert.rejects(refresh, /scope unavailable/);
  await assert.rejects(f.runtime.result(f.owner, f.task), /scope unavailable/);
});
test('PIE-030 lost submit acknowledgment is reconciled from provider metadata; deadlines cancel the original job', async (t) => {
  const f = setup(t, { lose: true });
  f.grant();
  const first = await f.submit();
  assert.equal(first.status, 'pending');
  assert.equal((await f.submit()).status, 'submission-unknown');
  assert.equal(f.api.calls.length, 1);
  const intent = f.api.intent;
  f.api.intent = 'different';
  await assert.rejects(
    f.runtime.refresh(f.owner, f.task, { responseId: 'resp_fixture' }),
    /does not match/
  );
  assert.equal(f.store.read().records[f.task].pendingAction, intent);
  f.api.intent = intent;
  await f.runtime.refresh(f.owner, f.task, { responseId: 'resp_fixture' });
  assert.equal(f.store.read().records[intent].status, 'confirmed');
  f.time.now = 1001;
  assert.equal(
    (await f.runtime.supervise(f.owner, f.task)).status,
    'cancelled'
  );
  const len = f.api.calls.length;
  await f.runtime.cancel(f.owner, f.task);
  assert.equal(f.api.calls.length, len);
  assert.doesNotMatch(
    JSON.stringify(f.store.read()),
    /private provider detail|private prompt bytes|never-persist/
  );
});

test('PIE-030 discards in-flight result text when the account rotates during the body read', async (t) => {
  const f = setup(t);
  f.grant();
  await f.submit();
  f.api.status = 'completed';
  await f.runtime.refresh(f.owner, f.task);
  f.api.duringRead = () => f.accounts.rotate(f.owner, f.account, 'secret-ref:fixture');
  await assert.rejects(f.runtime.result(f.owner, f.task), /confirmed|unavailable/);
});

test('PIE-031 account containment fences remote reconciliation before dispatch and before commit', async (t) => {
  const f = setup(t, { lose: true });
  f.grant();
  await f.submit();
  const intent = f.api.intent;
  let calls = 0;
  let revoke = true;
  const adapter = {
    manifest: { version: 1, platform: 'openai-responses', idempotency: 'recipient-key' },
    async send() { throw Error('unexpected send'); },
    async reconcile() {
      calls++;
      if (revoke) f.accounts.revoke(f.owner, f.account);
      return { state: 'confirmed', reference: 'receipt:synthetic' };
    }
  };
  const reconcile = () => reconcileEffect(f.engine, f.owner, f.task, adapter);
  await assert.rejects(reconcile, /scope unavailable/);
  assert.equal(calls, 1);
  assert.equal(f.store.read().records[f.task].pendingAction, intent);
  await assert.rejects(reconcile, /scope unavailable/);
  assert.equal(calls, 1);
  assert.equal(f.store.read().records[intent].status, 'pending');

  const next = setup(t, { lose: true });
  next.grant();
  await next.submit();
  revoke = false;
  assert.equal((await reconcileEffect(next.engine, next.owner, next.task, adapter)).status, 'done');
  assert.equal(next.store.read().records[next.api.intent].evidence, 'receipt:synthetic');
});
