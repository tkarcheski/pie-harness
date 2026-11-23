import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../packages/local/store.mjs';
import { sampleDomain } from '../apps/control-plane/local.mjs';
import {
  Accounts,
  OwnerPolicy,
  authorize,
  payloadDigest
} from '../packages/local/authority.mjs';
import { ownerCommand } from '../packages/local/operations.mjs';

test('contained account requires a current digest-bound owner decision and remains isolated from peers', async (t) => {
  let now = 1000;
  const store = new Store(':memory:', () => now);
  t.after(() => store.close());
  const { owner, actor, business } = sampleDomain(store),
    accounts = new Accounts(store),
    policy = new OwnerPolicy(store);
  const account = () =>
    accounts.register(owner, {
      business,
      recoveryOwner: owner,
      platform: 'fixture',
      scopes: ['read', 'observe'],
      expiresAt: 5000,
      secretRef: 'secret-ref:fixture'
    }).id;
  const a = account(),
    b = account();
  const grant = (id) =>
    policy.grant(owner, {
      actor,
      account: id,
      action: 'read',
      currency: 'USD',
      limitMinor: 0,
      validFrom: now,
      expiresAt: 4000
    });
  const ga = grant(a);
  grant(b);
  const proposal = (id) => ({
    actor,
    account: id,
    action: 'read',
    object: 'catalog',
    digest: payloadDigest('read'),
    currency: 'USD',
    amountMinor: 0,
    policyVersion: 1
  });
  const decide = (id) =>
    store.change((s) => authorize(s, now, owner, proposal(id))).decision;
  const cmd = (command, args) => ownerCommand({ store }, owner, command, args);
  const subject = {
    account: a,
    id: 'case-1',
    reason: 'unexpected-access',
    evidenceDigest: payloadDigest('synthetic private evidence')
  };
  const decision = {
    account: a,
    id: subject.id,
    reviewDigest: payloadDigest('reviewed fixture'),
    expiresAt: now + 1500
  };
  assert.equal(decide(a), 'allow');
  policy.approve(owner, proposal(a), 4500);
  // Persisted exact approvals from the revision-zero schema remain readable.
  store.change((s) => {
    delete s.approvals[0].revision;
  });
  const checked = await accounts.probe(
    owner,
    a,
    'read',
    { resolve: async () => 'generated' },
    async () => {
      cmd('connection-suspend', subject);
      return true;
    }
  );
  assert.equal(checked, false);
  assert.equal(decide(b), 'allow');
  assert.equal(decide(a), 'deny');
  assert.throws(() => policy.approve(owner, proposal(a), 4500), /unavailable/);
  assert.throws(() => cmd('connection-restore', decision), /approval/);
  cmd('connection-approve-restore', decision);
  accounts.rotate(owner, a, 'secret-ref:replacement');
  assert.throws(() => cmd('connection-restore', decision), /superseded/);
  cmd('connection-approve-restore', decision);
  cmd('connection-restore', decision);
  cmd('connection-restore', decision);
  assert.equal(decide(a), 'allow');
  assert.equal(store.read().approvals[0].used, false);
  const audit = cmd('audit', {});
  assert.equal(audit.incidents[0].reviewDigest, decision.reviewDigest);
  assert.equal(audit.incidents[0].evidenceDigest, subject.evidenceDigest);
  assert.ok(audit.events.some((e) => e.incident === subject.id));
  policy.pause(owner, a);
  let probes = 0;
  assert.equal(
    await accounts.probe(
      owner,
      a,
      'read',
      {
        resolve: async () => {
          probes++;
        }
      },
      async () => true
    ),
    false
  );
  assert.equal(probes, 0);
  const unavailable = () =>
    accounts.probe(
      owner,
      a,
      'read',
      { resolve: async () => 'fixture' },
      async () => true
    );
  await unavailable();
  assert.equal(
    store
      .read()
      .ownerTasks.filter((t) => t.account === a && t.resolvedAt === undefined)
      .length,
    1
  );
  policy.resume(owner, a);
  const provider = { resolve: async () => 'fixture' };
  const observe = (ok) =>
    accounts.probe(owner, a, 'observe', provider, async () => ok);
  assert.equal(await observe(false), false);
  assert.equal(await unavailable(), true);
  assert.ok(
    store
      .read()
      .alerts.some(
        (x) => x.subject === a && x.code === 'connection' && x.status === 'open'
      )
  );
  assert.equal(await observe(true), true);
  assert.equal(
    store
      .read()
      .ownerTasks.filter((t) => t.account === a && t.resolvedAt === undefined)
      .length,
    0
  );
  assert.equal(
    store.read().events.filter((e) => e.type === 'connection-restored').length,
    1
  );
  assert.ok(
    !JSON.stringify(store.read()).includes('synthetic private evidence')
  );
  const expiry = () => cmd('connection-expiry', { horizonMs: 3100 });
  assert.equal(expiry().length, 2);
  expiry();
  const alert = store.read().alerts.find((x) => x.subject === ga);
  cmd('ack', { id: alert.id });
  cmd('connection-expiry', { horizonMs: 0 });
  assert.equal(
    store.read().alerts.find((x) => x.id === alert.id).status,
    'acknowledged'
  );
  assert.equal(
    store.read().alerts.find((x) => x.subject === ga).occurrences,
    1
  );
  policy.revokeGrant(owner, ga);
  expiry();
  assert.equal(
    store.read().alerts.find((x) => x.subject === ga).status,
    'resolved'
  );
  const other = store
    .read()
    .alerts.find((x) => x.account === b && x.code === 'connection-expiry');
  cmd('ack', { id: other.id });
  now = 4100;
  assert.equal(expiry().find((r) => r.kind === 'grant').state, 'expired');
  assert.equal(
    store.read().alerts.find((x) => x.id === other.id).status,
    'open'
  );
});
