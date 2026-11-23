import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../packages/local/store.mjs';
import { Execution } from '../packages/local/execution.mjs';
import { sampleDomain } from '../apps/control-plane/local.mjs';
import { payloadDigest } from '../packages/local/authority.mjs';
import {
  completeStage,
  submitTeam,
  teamPacket
} from '../packages/connectors/team.mjs';
import {
  checkConformance,
  connectorV1,
  fixtureConnector
} from '../packages/connectors/sdk.mjs';

test('PIE-022 fenced planner/executor/reviewer handoffs recover timeouts and prevent self-approval', (t) => {
  let now = 1;
  const store = new Store(':memory:', () => now);
  t.after(() => store.close());
  const scope = sampleDomain(store);
  const engine = new Execution(store, { heartbeatMs: 1000, leaseMs: 25 });
  const members = {},
    workers = {};
  for (const role of ['planner', 'executor', 'reviewer']) {
    const worker = engine.enroll(scope.owner);
    engine.probe(scope.owner, worker.node, {
      name: 'team.' + role + '.' + worker.node,
      version: '1',
      state: 'supported',
      evidence: 'synthetic role checkout'
    });
    workers[role] = worker;
    members[role] = {
      node: worker.node,
      actor: store.create('agent', scope.owner, { business: scope.business }).id
    };
    engine.heartbeat(worker, true);
  }
  const spec = {
    key: 'trial',
    run: scope.run,
    budgetRef: 'local',
    inputRef: 'artifact:brief',
    members,
    durationMs: 100,
    maxAttempts: 2
  };
  const submit = () => submitTeam(store, scope.owner, spec);
  const team = submit();
  assert.deepEqual(submit(), team);
  assert.throws(
    () =>
      submitTeam(store, scope.owner, {
        ...spec,
        members: { ...members, reviewer: members.executor }
      }),
    /independently/
  );
  assert.equal(engine.claim(workers.reviewer), null);
  const expired = engine.claim(workers.planner);
  now += 26;
  const artifact = {
    outputRef: 'artifact:plan',
    digest: payloadDigest('plan')
  };
  assert.throws(
    () =>
      completeStage(
        engine,
        scope.owner,
        'trial',
        expired.task,
        { ...workers.planner, fence: expired.fence },
        artifact
      ),
    /lease/
  );
  for (let i = 0; i < team.stages.length; i++) {
    const { role, task } = team.stages[i],
      claim = engine.claim(workers[role]);
    const worker = { ...workers[role], fence: claim.fence };
    assert.equal(task, claim.task);
    assert.equal(
      teamPacket(store, scope.owner, 'trial', task, worker).upstream.length,
      i
    );
    if (role !== 'reviewer')
      assert.throws(
        () =>
          completeStage(engine, scope.owner, 'trial', task, worker, {
            ...artifact,
            decision: 'accept'
          }),
        /independent reviewer/
      );
    completeStage(engine, scope.owner, 'trial', task, worker, {
      ...artifact,
      outputRef: 'artifact:' + role,
      ...(role === 'reviewer' && { decision: 'return' })
    });
  }
  assert.equal(submit().handoffs[2].decision, 'return');
  const late = submitTeam(store, scope.owner, {
    ...spec,
    key: 'late',
    durationMs: 1
  });
  now += 2;
  assert(
    engine
      .inspect(scope.owner)
      .tasks.filter((x) => late.stages.some((y) => y.task === x.id))
      .every((x) => x.status === 'failed')
  );
});

test('PIE-031 contributor conformance exercises receipt loss, absence, replay and conflicting bytes', async () => {
  assert.deepEqual((await checkConformance(fixtureConnector)).passed, [
    'none',
    'before-write',
    'after-write'
  ]);
  await assert.rejects(
    checkConformance(() => fixtureConnector()),
    /Unexpected acknowledgment/
  );
  const broken = fixtureConnector();
  broken.reconcile = () => {
    throw Error('sensitive provider detail');
  };
  assert.deepEqual(await connectorV1(broken).reconcile('0'.repeat(64)), {
    state: 'unknown'
  });
  assert.throws(
    () =>
      connectorV1({ ...broken, manifest: { ...broken.manifest, version: 2 } }),
    /version 1/
  );
});
