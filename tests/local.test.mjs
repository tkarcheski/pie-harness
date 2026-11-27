import assert from 'node:assert/strict';
import test from 'node:test';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../packages/local/store.mjs';
import {
  Accounts,
  OwnerPolicy,
  payloadDigest,
  DevelopmentSecrets
} from '../packages/local/authority.mjs';
import { Execution } from '../packages/local/execution.mjs';
import {
  setBudget,
  auditView,
  ownerCommand
} from '../packages/local/operations.mjs';
import { sampleDomain } from '../apps/control-plane/local.mjs';

test('PIE-008 pins a reservation across connections and retries the same logical effect with the same key', async (t) => {
  const f = fixture(t),
    owner = f.scope.owner;
  const limit = {
    business: f.scope.business,
    ref: 'sample-budget',
    currency: 'USD',
    limitMinor: 20
  };
  setBudget(f.store, owner, limit);
  f.policy.grant(owner, { ...f.grant, limitMinor: 20 });
  const peerStore = new Store(f.filename, () => f.clock.now);
  try {
    const peer = new Execution(peerStore, config);
    const worker2 = peer.enroll(owner);
    peer.heartbeat(worker2, true);
    peer.probe(owner, worker2.node, f.probe);
    const a = f.task({ retryLimit: 1 }),
      b = f.task();
    const lease1 = { ...f.worker, fence: f.execution.claim(f.worker).fence };
    const lease2 = { ...worker2, fence: peer.claim(worker2).fence };
    const payload = 'synthetic payload',
      seen = [];
    let reservedDuringSend, competingDecision;
    await assert.rejects(
      f.execution.dispatchEffect(a.id, lease1, f.request, 'changed', {
        send() {
          throw Error('unexpected dispatch');
        }
      }),
      /digest/i
    );
    const first = await f.execution.dispatchEffect(
      a.id,
      lease1,
      f.request,
      payload,
      {
        send(_bytes, context) {
          seen.push(context);
          reservedDuringSend = auditView(peerStore, owner).budgets[0]
            .reservedMinor;
          competingDecision = peer.beginEffect(
            b.id,
            lease2,
            f.request
          ).decision;
          throw Error('synthetic uncertain send');
        }
      }
    );
    assert.equal(first.status, 'pending');
    assert.equal(reservedDuringSend, 15);
    assert.equal(competingDecision, 'require-owner');
    assert.throws(
      () => setBudget(peerStore, owner, { ...limit, limitMinor: 14 }),
      /reservations/
    );
    assert.throws(
      () =>
        ownerCommand(peer, owner, 'reconcile', {
          task: a.id,
          confirmed: false,
          evidence: 'verified absent',
          intent: 'old'
        }),
      /intent changed/
    );
    assert.equal(f.execution.claim(f.worker), null);
    f.execution.reconcile(
      owner,
      a.id,
      false,
      'receipt lookup verified absent',
      first.intent
    );
    assert.equal(auditView(peerStore, owner).budgets[0].availableMinor, 20);
    const retry = { ...f.worker, fence: f.execution.claim(f.worker).fence };
    const result = await f.execution.dispatchEffect(
      a.id,
      retry,
      f.request,
      payload,
      {
        send(bytes, ctx) {
          assert.equal(bytes.toString(), payload);
          seen.push(ctx);
          return 'synthetic receipt';
        }
      }
    );
    assert.equal(result.status, 'confirmed');
    assert.equal(seen[0].idempotencyKey, seen[1].idempotencyKey);
    assert.notEqual(seen[0].intent, seen[1].intent);
    const ledger = auditView(peerStore, owner);
    assert.deepEqual(ledger.costsMinorByCurrency, { USD: 15 });
    assert.equal(ledger.budgets[0].reservedMinor, 0);
  } finally {
    peerStore.close();
  }
});

test('PIE-009 redacts audit details, joins attempt and intent, deduplicates alerts and time entries', (t) => {
  const f = fixture(t),
    owner = f.scope.owner;
  const a = f.task(),
    claim = f.execution.claim(f.worker),
    w = { ...f.worker, fence: claim.fence };
  const request = { ...f.request, object: 'sensitive-target-string' };
  f.policy.approve(owner, request, 250);
  setBudget(f.store, owner, {
    business: f.scope.business,
    ref: 'sample-budget',
    currency: 'USD',
    limitMinor: 0
  });
  for (let i = 0; i < 2; i++)
    assert.equal(
      f.execution.beginEffect(a.id, w, request).decision,
      'require-owner'
    );
  let report = auditView(f.store, owner);
  assert.equal(report.alerts.length, 1);
  assert.equal(report.alerts[0].occurrences, 2);
  assert.equal(
    ownerCommand(f.execution, owner, 'ack', { id: report.alerts[0].id }).status,
    'acknowledged'
  );
  for (let i = 0; i < 2; i++)
    ownerCommand(f.execution, owner, 'time', {
      task: a.id,
      minutes: 3,
      entryId: 'time-1'
    });
  assert.throws(
    () =>
      ownerCommand(f.execution, owner, 'time', {
        task: a.id,
        minutes: 4,
        entryId: 'time-1'
      }),
    /already used/
  );
  setBudget(f.store, owner, {
    business: f.scope.business,
    ref: 'sample-budget',
    currency: 'USD',
    limitMinor: 20
  });
  const intent = f.execution.beginEffect(a.id, w, request).intent;
  assert.ok(intent, 'budget refusal must preserve the unspent exact approval');
  f.execution.reconcile(owner, a.id, true, 'private-receipt-body', intent);
  report = auditView(f.store, owner);
  assert.equal(report.alerts[0].status, 'resolved');
  assert.equal(report.ownerMinutes, 3);
  assert.deepEqual(report.costsMinorByCurrency, { USD: 15 });
  assert.ok(
    report.events.some(
      (e) =>
        e.type === 'effect-confirmed' &&
        e.task === a.id &&
        e.attempt === claim.attempt &&
        e.intent === intent
    )
  );
  assert.doesNotMatch(
    JSON.stringify(report),
    /sensitive-target-string|private-receipt-body|secret-ref/
  );
  assert.equal(
    auditView(f.store, f.store.create('owner', null).id).events.length,
    0
  );
});

test('PIE-010 owner ranking changes dispatch, retry honors the original deadline, and cancel preserves uncertain effects', (t) => {
  const f = fixture(t),
    owner = f.scope.owner,
    engine = f.execution;
  const first = f.task(),
    promoted = f.task({ deadline: 180 });
  const child = f.task({ dependsOn: [promoted.id] });
  engine.rank(owner, promoted.id, 10);
  assert.equal(engine.inspect(owner).tasks[0].id, promoted.id);
  const claim = engine.claim(f.worker);
  assert.equal(claim.task, promoted.id);
  engine.fail(
    promoted.id,
    { ...f.worker, fence: claim.fence },
    'private adapter failure'
  );
  assert.equal(
    engine.inspect(owner).tasks.find((x) => x.id === child.id).status,
    'blocked'
  );
  assert.throws(() => engine.retry(owner, promoted.id, 5), /one additional/);
  f.policy.pause(owner);
  assert.throws(() => engine.retry(owner, promoted.id, 2), /policy/);
  assert.equal(engine.claim(f.worker), null);
  f.policy.resume(owner);
  engine.retry(owner, promoted.id, 2);
  assert.equal(
    engine.inspect(owner).tasks.find((x) => x.id === child.id).waitingReason,
    'Waiting for prerequisites'
  );
  f.clock.now = 180;
  assert.equal(engine.inspect(owner).tasks[0].status, 'failed');
  assert.throws(() => engine.retry(owner, promoted.id, 2), /policy/);
  engine.heartbeat(f.worker, true);
  const next = engine.claim(f.worker);
  assert.equal(next.task, first.id);
  f.policy.grant(owner, { ...f.grant, limitMinor: 20 });
  const intent = engine.beginEffect(
    first.id,
    { ...f.worker, fence: next.fence },
    f.request
  ).intent;
  assert.equal(engine.cancel(owner, first.id).status, 'needs-reconciliation');
  engine.reconcile(owner, first.id, false, 'verified absent', intent);
  assert.equal(
    engine.inspect(owner).tasks.find((x) => x.id === first.id).status,
    'canceled'
  );
});

const config = { heartbeatMs: 10, leaseMs: 5 };
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-store-')),
    filename = path.join(dir, 'state.sqlite');
  const clock = { now: 100 };
  const store = new Store(filename, () => clock.now);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const scope = sampleDomain(store);
  setBudget(store, scope.owner, {
    business: scope.business,
    ref: 'sample-budget',
    currency: 'USD',
    limitMinor: 100
  });
  const execution = new Execution(store, config);
  const worker = execution.enroll(scope.owner);
  const probe = {
    name: 'review',
    state: 'supported',
    version: 'v1',
    evidence: 'fixture-result'
  };
  execution.heartbeat(worker, true);
  execution.probe(scope.owner, worker.node, probe);
  const task = (options = {}) =>
    execution.enqueue(scope.owner, {
      ...scope,
      capability: 'review',
      budgetRef: 'sample-budget',
      ...options
    });
  const accounts = new Accounts(store);
  const account = accounts.register(scope.owner, {
    business: scope.business,
    recoveryOwner: scope.owner,
    scopes: ['draft'],
    expiresAt: 1000,
    platform: 'fixture',
    secretRef: 'secret-ref:demo'
  });
  const request = {
    actor: scope.actor,
    account: account.id,
    action: 'draft',
    object: 'example',
    digest: payloadDigest('synthetic payload'),
    amountMinor: 15,
    currency: 'USD',
    policyVersion: 1
  };
  const policy = new OwnerPolicy(store);
  const grant = {
    actor: scope.actor,
    account: account.id,
    action: 'draft',
    currency: 'USD',
    limitMinor: 10,
    validFrom: 100,
    expiresAt: 300
  };
  return {
    dir,
    filename,
    clock,
    store,
    scope,
    execution,
    worker,
    probe,
    task,
    accounts,
    account,
    request,
    policy,
    grant
  };
}

test('PIE-001 standalone startup validates before opening the state database', (t) => {
  const dir = directory(t);
  const script = fileURLToPath(
    new URL('../apps/control-plane/local.mjs', import.meta.url)
  );
  const file = path.join(dir, 'fixture.json'),
    db = path.join(dir, 'state.sqlite');
  const settings = JSON.parse(
    fs.readFileSync(
      new URL('../apps/control-plane/fixture.config.json', import.meta.url)
    )
  );
  const run = () =>
    spawnSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, PIE_CONFIG: file, PIE_STATE_DB: db },
      encoding: 'utf8'
    });
  for (const invalid of [
    { ...settings, allowWrites: true },
    { ...settings, connectorsEnabled: true },
    { ...settings, leaseMs: 0 }
  ]) {
    fs.writeFileSync(file, JSON.stringify(invalid));
    assert.notEqual(run().status, 0);
    assert.equal(fs.existsSync(db), false);
  }
  fs.writeFileSync(file, JSON.stringify(settings));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).tasks[0].status, 'done');
});

test('PIE-002 versioned record relationships survive migration and restart', (t) => {
  const { store, scope, filename, task, execution, worker } = fixture(t);
  const work = task(),
    claim = execution.claim(worker);
  execution.checkpoint(
    work.id,
    { ...worker, fence: claim.fence },
    'artifact-reference'
  );
  const before = store.read();
  const other = store.create('owner', null);
  assert.throws(
    () => store.create('run', other.id, { experiment: scope.experiment }),
    /Cross-owner/
  );
  assert.throws(() => task({ run: scope.actor }), /Missing run/);
  assert.equal(before.records[work.id].experiment, scope.experiment);
  assert.equal(before.records[claim.attempt].task, work.id);
  assert.equal(
    before.records[before.records[work.id].checkpoint].attempt,
    claim.attempt
  );
  assert.equal(before.records[work.id].forecast, undefined);
  // Build a genuine v1 database and open it through the normal migration path.
  const old = filename + '.v1',
    db = new DatabaseSync(old);
  db.exec(
    'CREATE TABLE workspace(id INTEGER PRIMARY KEY, data TEXT); PRAGMA user_version=1'
  );
  db.prepare('INSERT INTO workspace VALUES(1,?)').run(
    JSON.stringify({ records: before.records, events: before.events })
  );
  db.close();
  const migrated = new Store(old);
  try {
    assert.deepEqual(migrated.read().records, before.records);
    assert.deepEqual(migrated.read().grants, []);
    assert.equal(
      migrated.db.prepare('PRAGMA user_version').get().user_version,
      2
    );
  } finally {
    migrated.close();
  }
});

test('PIE-003 dependencies, cycles, failure propagation and legal transitions', (t) => {
  const { scope, execution, worker, task, store } = fixture(t);
  const first = task(),
    second = task({ dependsOn: [first.id] }),
    third = task({ dependsOn: [second.id] });
  assert.throws(
    () => execution.dependencies(scope.owner, first.id, [third.id]),
    /cycle/
  );
  const claim = execution.claim(worker);
  assert.equal(claim.task, first.id);
  assert.equal(execution.claim(worker), null);
  execution.fail(
    first.id,
    { ...worker, fence: claim.fence },
    'Fixture verification failed',
    { stage: 'validation', code: 'INVALID_OUTPUT' }
  );
  const failedState = store.read();
  assert.deepEqual(failedState.records[claim.attempt].failure, {
    message: 'Fixture verification failed',
    stage: 'validation',
    code: 'INVALID_OUTPUT'
  });
  const failureEvent = failedState.events.find(e => e.task === first.id && e.to === 'failed');
  assert.equal(failureEvent.attempt, claim.attempt);
  assert.equal(failureEvent.reason, 'Fixture verification failed');
  assert.deepEqual(
    execution.inspect(scope.owner).tasks.map((t) => t.status),
    ['failed', 'blocked', 'blocked']
  );
  assert.throws(
    () => execution.complete(first.id, { ...worker, fence: claim.fence }),
    /Stale lease/
  );
  assert.ok(
    store
      .read()
      .events.some((e) => e.to === 'blocked' && e.time === 100 && e.reason)
  );
  const canceled = task();
  execution.cancel(scope.owner, canceled.id);
  assert.equal(execution.claim(worker), null);
});

test('PIE-004 checkpoint recovery fences stale workers after reopening', (t) => {
  const { scope, execution, worker, task, filename, clock } = fixture(t);
  const first = task({ retryLimit: 1 }),
    dependent = task({ dependsOn: [first.id] });
  const lease = execution.claim(worker);
  execution.checkpoint(
    first.id,
    { ...worker, fence: lease.fence },
    'portable-output'
  );
  clock.now += 6;
  const resumedStore = new Store(filename, () => clock.now);
  try {
    const resumed = new Execution(resumedStore, config),
      retry = resumed.claim(worker);
    assert.equal(retry.task, first.id);
    assert.notEqual(retry.fence, lease.fence);
    assert.ok(retry.checkpoint);
    assert.throws(
      () => execution.complete(first.id, { ...worker, fence: lease.fence }),
      /Stale lease/
    );
    resumed.complete(first.id, { ...worker, fence: retry.fence });
    assert.equal(resumed.claim(worker).task, dependent.id);
  } finally {
    resumedStore.close();
  }
  assert.equal(execution.inspect(scope.owner).tasks[0].attempts, 2);
});

test(
  'PIE-004 kills a worker after acceptance; reconciliation prevents duplicate delivery',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t);
    const work = f.task({ retryLimit: 1 }),
      receipts = path.join(f.dir, 'receipts.txt');
    f.policy.approve(f.scope.owner, f.request, 500);
    const child = fork(
      new URL('./fixtures/interrupted-worker.mjs', import.meta.url),
      [],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }
    );
    t.after(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
    });
    const ready = once(child, 'message');
    child.send({
      filename: f.filename,
      now: f.clock.now,
      config,
      worker: f.worker,
      request: f.request,
      receipts
    });
    const [{ intent }] = await ready;
    const exit = once(child, 'exit');
    child.kill('SIGKILL');
    await exit;
    f.clock.now += 6;
    assert.equal(f.execution.claim(f.worker), null);
    assert.equal(
      f.execution.inspect(f.scope.owner).tasks[0].status,
      'needs-reconciliation'
    );
    assert.equal(fs.readFileSync(receipts, 'utf8').trim(), intent);
    f.execution.reconcile(f.scope.owner, work.id, true, 'receipt-1');
    assert.equal(f.execution.claim(f.worker), null);
    assert.equal(f.store.read().records[work.id].status, 'done');
  }
);

test('PIE-005 trust, heartbeat, measured capability, drain and capacity gate dispatch', (t) => {
  const { worker, scope, execution, probe, clock, task } = fixture(t);
  task();
  assert.throws(
    () => execution.heartbeat({ ...worker, token: 'wrong' }, true),
    /enrollment/
  );
  for (const state of ['unknown', 'probed', 'degraded', 'unsupported']) {
    execution.probe(scope.owner, worker.node, { ...probe, state });
    assert.equal(execution.claim(worker), null);
  }
  execution.probe(scope.owner, worker.node, probe);
  execution.drain(scope.owner, worker.node);
  assert.equal(execution.inspect(scope.owner).nodes[0].state, 'draining');
  assert.equal(execution.claim(worker), null);
  execution.drain(scope.owner, worker.node, false);
  clock.now += 10;
  assert.equal(execution.inspect(scope.owner).nodes[0].state, 'offline');
  assert.equal(execution.claim(worker), null);
  execution.heartbeat(worker, false);
  assert.equal(execution.claim(worker), null);
  execution.heartbeat(worker, true);
  const lease = execution.claim(worker);
  assert.deepEqual(execution.inspect(scope.owner).nodes[0].activeTasks, [
    lease.task
  ]);
  execution.revoke(scope.owner, worker.node);
  assert.throws(
    () => execution.renew(lease.task, { ...worker, fence: lease.fence }),
    /enrollment/
  );
  assert.equal(execution.inspect(scope.owner).tasks[0].status, 'failed');
});

test('PIE-006 secret boundary redacts lookup failures, supports rotation and revocation', async (t) => {
  const { accounts, scope, account, store } = fixture(t);
  const provider = new DevelopmentSecrets(),
    probe = (verify) =>
      accounts.probe(scope.owner, account.id, 'draft', provider, verify);
  const synthetic = 'generated-' + Math.random();
  assert.equal(await probe(() => true), false);
  provider.set(account.secretRef, synthetic);
  assert.equal(await probe((value) => value === synthetic), true);
  assert.equal(
    await probe(() => {
      throw Error(synthetic);
    }),
    false
  );
  accounts.rotate(scope.owner, account.id, 'secret-ref:rotated');
  assert.equal(await probe(() => true), false);
  provider.set('secret-ref:rotated', synthetic);
  assert.equal(await probe(() => true), true);
  accounts.revoke(scope.owner, account.id);
  assert.equal(await probe(() => true), false);
  assert.ok(store.read().ownerTasks.length >= 4);
  assert.ok(!JSON.stringify(store.read()).includes(synthetic));
  assert.throws(
    () => accounts.register(scope.owner, { ...account, credential: synthetic }),
    /metadata/
  );
});

test('PIE-007 exact approvals, standing grants, scope, escalation and pauses', (t) => {
  const {
    task,
    execution,
    scope,
    worker,
    request,
    policy,
    grant,
    store,
    clock
  } = fixture(t);
  const work = task(),
    lease = execution.claim(worker),
    session = { ...worker, fence: lease.fence };
  const propose = (r) => execution.beginEffect(work.id, session, r).decision;
  assert.equal(propose(request), 'deny');
  policy.grant(scope.owner, grant);
  assert.equal(propose(request), 'require-owner');
  assert.throws(() => policy.approve(scope.actor, request, 200), /owner/);
  assert.equal(propose({ ...request, action: 'other' }), 'deny');
  policy.approve(scope.owner, request, 200);
  assert.equal(
    propose({ ...request, digest: payloadDigest('modified') }),
    'require-owner'
  );
  assert.equal(propose(request), 'allow');
  assert.throws(() => propose(request), /already pending/);
  execution.reconcile(scope.owner, work.id, true, 'fixture receipt');
  const next = task(),
    session2 = { ...worker, fence: execution.claim(worker).fence };
  const decide = (r) => execution.beginEffect(next.id, session2, r).decision;
  assert.equal(decide(request), 'require-owner');
  policy.pause(scope.owner, request.account);
  assert.equal(decide({ ...request, amountMinor: 1 }), 'deny');
  assert.ok(store.read().events.some((e) => e.reason === 'Paused'));
  const f = fixture(t);
  f.policy.grant(f.scope.owner, { ...f.grant, limitMinor: 20 });
  const make = () => {
    const job = f.task();
    const lease = f.execution.claim(f.worker);
    return { ...f.worker, fence: lease.fence, job };
  };
  const a = make();
  assert.equal(
    f.execution.beginEffect(a.job.id, a, f.request).decision,
    'allow'
  );
  f.execution.reconcile(f.scope.owner, a.job.id, true, 'receipt');
  f.clock.now = 310;
  f.execution.heartbeat(f.worker, true);
  const b = make();
  assert.equal(
    f.execution.beginEffect(b.job.id, b, f.request).decision,
    'deny'
  );
  f.policy.approve(f.scope.owner, f.request, 350);
  f.policy.pause(f.scope.owner, '*');
  assert.equal(
    f.execution.beginEffect(b.job.id, b, f.request).decision,
    'deny'
  );
});
