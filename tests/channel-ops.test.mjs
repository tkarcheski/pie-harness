import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Studio } from '../apps/studio/channel.mjs';
import { fixtureWriter } from '../apps/studio/writer.mjs';
import { deskCommand } from '../packages/channel-ops/desk.mjs';

const minute = 60000;
function workspace(t) {
  let now = Date.UTC(2025, 0, 2),
    seq = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-channel-scenario-'));
  const h = {
    dir,
    get now() {
      return now;
    },
    advance(ms) {
      now += ms;
    }
  };
  const open = (initialize) =>
    new Studio(dir, { initialize, clock: () => now });
  h.studio = open(true);
  h.studio.init({ topic: 'Practice', audience: 'synthetic operators' });
  h.reopen = () => {
    h.studio.close();
    h.studio = open(false);
  };
  h.write = (cmd, input = {}, role = 'owner') =>
    deskCommand(
      h.studio.store,
      cmd,
      { requestId: 'test-' + ++seq, ...input },
      role
    );
  h.read = (cmd = 'status', o = {}) => deskCommand(h.studio.store, cmd, o);
  h.src = (name, note = 'Synthetic local observation') => ({
    ref: 'evidence:' + name,
    note,
    observedAt: now
  });
  h.study = (id = 'study', opts = {}) =>
    h.write('research-open', {
      id,
      hypothesis: 'A small guide covers all five checklist items.',
      criterion:
        'Independently compare an input checklist and an original draft.',
      minSources: 1,
      ...opts
    });
  h.finding = (id, source, status = 'supports', citation = h.src(source)) => {
    const a = h.write(
      'research-begin',
      { id, question: 'Check ' + source },
      'agent'
    );
    return h.write(
      'research-result',
      {
        id,
        attempt: a.id,
        status,
        sourceId: source,
        claim: 'Measured checklist field count',
        evidence: citation
      },
      'agent'
    );
  };
  h.register = () =>
    h.write('channel-register', {
      channelName: 'Original guides',
      personaName: 'Editor',
      ownership: h.src('owner'),
      healthMinutes: 2
    });
  h.grant = (scope, until = now + 120 * minute) =>
    h.write('channel-grant', {
      scope,
      validUntil: until,
      evidence: h.src(scope)
    });
  h.doc = (id = 'license', type = 'right', expiry = now + 120 * minute) =>
    h.write('document-register', {
      id,
      type,
      title: 'Source review',
      responsible: 'Local operator',
      evidence: h.src(id),
      reviewBy: expiry,
      validUntil: expiry
    });
  h.approveDoc = (id = 'license') =>
    h.write('document-review', {
      id,
      status: 'approved',
      note: 'Source checked',
      evidence: h.src('check-' + id)
    });
  h.product = () =>
    h.studio.product({
      title: 'Practice guide',
      source: 'A local draft',
      rightsConfirmed: true,
      rights: ['license'],
      priceMinor: 500
    }).product;
  h.plan = (product, id = 'edition', opts = {}) =>
    h.write('experiment-plan', {
      id,
      product,
      opportunity: 'guide',
      hypothesis: 'At least five of ten trials meet the original checklist.',
      metric: 'Completed checklist per local use',
      baseline: { successes: 5, trials: 10, evidence: h.src('baseline') },
      costCapMinor: 5,
      ownerCapMinutes: 20,
      minTrials: 10,
      rollbackBelowBps: 0,
      targetDeltaBps: 1000,
      endsAt: now + 60 * minute,
      ...opts
    });
  h.approve = (id = 'edition') =>
    h.write('experiment-approve', {
      id,
      note: 'Local owner approves the reviewed edition'
    });
  h.ready = async () => {
    await h.studio.work();
    h.register();
    h.grant('draft');
    h.grant('publish-local');
    h.doc();
    h.approveDoc();
    h.study();
    h.finding('study', 'source');
    h.write('opportunity-record', {
      id: 'guide',
      study: 'study',
      title: 'Guide',
      category: 'recurring',
      forecast: { ownerMinutes: 5 },
      evidence: h.src('forecast')
    });
    const p = h.product();
    await h.studio.work();
    h.plan(p);
    h.approve();
    h.studio.review({ product: p, decision: 'approve' });
    return p;
  };
  t.after(() => {
    h.studio.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

test('a corroborated finding requires distinct source and origin for each counted finding', (t) => {
  const h = workspace(t);
  h.study('overlapping', { minSources: 3 });
  const observe = (source, host) =>
    h.finding('overlapping', source, 'supports', {
      ...h.src(source),
      ref: 'https://' + host + '.example/report'
    }).status;
  assert.equal(observe('first', 'shared'), 'open');
  assert.equal(observe('second', 'shared'), 'open');
  assert.equal(observe('third', 'shared'), 'open');
  assert.equal(observe('first', 'mirror-one'), 'open');
  assert.equal(observe('first', 'mirror-two'), 'open');
  // The first finding's source can now use a mirror while the second uses its own origin.
  assert.equal(observe('second', 'independent'), 'supported');
});

test('Studio status retires expired editions after an unattended restart', async (t) => {
  const h = workspace(t),
    product = await h.ready();
  h.advance(60 * minute);
  h.reopen();
  const info = h.studio.status();
  assert.equal(info.products.find((p) => p.id === product).status, 'retired');
  assert.equal(h.studio.store.read().channelOps.experiments.edition.state, 'stopped');
});

test('research applies independent evidence, total attempts, retry and elapsed deadlines across restart', (t) => {
  const h = workspace(t);
  assert.throws(
    () => h.study('too-long', { durationMinutes: 61 }),
    /job minutes/
  );
  assert.throws(
    () => h.study('too-long', { stepMinutes: 16 }),
    /attempt minutes/
  );
  h.study('timed', {
    durationMinutes: 4,
    stepMinutes: 1,
    maxRetries: 1,
    maxAttempts: 4
  });
  const a = h.write('research-begin', {
    id: 'timed',
    question: 'Read one reference'
  });
  h.advance(minute);
  h.reopen();
  assert.throws(
    () =>
      h.write('research-result', {
        id: 'timed',
        attempt: a.id,
        status: 'failed',
        reason: 'Late result'
      }),
    /expired|superseded/
  );
  const b = h.write('research-begin', {
    id: 'timed',
    question: 'Retry one reference'
  });
  const done = h.write('research-result', {
    id: 'timed',
    attempt: b.id,
    status: 'failed',
    reason: 'Source absent'
  });
  assert.equal(done.stopReason, 'Retry budget exhausted');
  assert.deepEqual(
    h.read('research-get', { id: 'timed' }).attempts.map((x) => x.status),
    ['timed-out', 'failed']
  );
  h.study('overall', { durationMinutes: 1 });
  h.advance(minute);
  assert.equal(
    h.read('research-get', { id: 'overall' }).stopReason,
    'Job deadline reached'
  );
  h.study('same-source', { maxAttempts: 3, minSources: 2 });
  const hosted = {
    ref: 'https://research.example.test/one',
    observedAt: h.now,
    note: 'First report'
  };
  h.finding('same-source', 'one', 'supports', hosted);
  assert.equal(
    h.finding('same-source', 'two', 'supports', {
      ...hosted,
      ref: 'https://www.research.example.test/two'
    }).status,
    'open'
  );
  assert.equal(
    h.finding('same-source', 'three', 'uncertain').stopReason,
    'Attempt cap reached'
  );
  h.study('counter');
  assert.equal(h.finding('counter', 'c', 'contradicts').status, 'challenged');
  h.study('ok', { minSources: 2 });
  h.finding('ok', 'first');
  assert.equal(h.finding('ok', 'second').status, 'supported');
});

test('ranking keeps measured and forecast values distinct, exposes missing inputs, constraints and scoped overrides', (t) => {
  const h = workspace(t);
  h.study();
  h.finding('study', 'source');
  const base = {
    study: 'study',
    title: 'Case',
    category: 'recurring',
    evidence: h.src('expected')
  };
  const forecast = {
    contributionMinor: 3000,
    cashDays: 5,
    reliabilityBps: 8000,
    growthBps: 400,
    ownerMinutes: 30
  };
  for (const [id, data, category] of [
    ['a', forecast, 'recurring'],
    ['b', { ...forecast, contributionMinor: 9000 }, 'liquidity'],
    ['c', {}, 'recurring']
  ])
    h.write('opportunity-record', { ...base, id, forecast: data, category });
  const actual = {
    id: 'a',
    metrics: { contributionMinor: 10000, cashDays: 8 },
    evidence: h.src('settlement-a')
  };
  h.write('opportunity-actual', { ...actual, requestId: 'bank-line' });
  h.reopen();
  h.write('opportunity-actual', { ...actual, requestId: 'bank-line' });
  assert.throws(
    () =>
      h.write('opportunity-actual', {
        ...actual,
        requestId: 'bank-line',
        metrics: { cashDays: 1 }
      }),
    /Conflicting/
  );
  const result = h.read('opportunity-rank', {
    weights: { contributionMinor: 100 },
    limits: { cashDays: 7 }
  });
  assert.deepEqual(
    result.opportunities.map((x) => [x.id, x.eligibility]),
    [
      ['b', 'ready'],
      ['c', 'needs-evidence'],
      ['a', 'outside-limits']
    ]
  );
  const a = result.opportunities.at(-1);
  assert.equal(a.actuals.length, 1);
  assert.equal(a.components.contributionMinor.value, 10000);
  assert.equal(a.forecast.contributionMinor, 3000);
  assert.equal(a.components.cashDays.basis, 'observed');
  assert.equal(a.components.ownerMinutes.basis, 'forecast');
  assert.equal(result.opportunities[1].missing.length, 5);
  assert.equal(result.weights.contributionMinor, 100);
  assert.throws(
    () =>
      h.write(
        'opportunity-override',
        { id: 'c', priority: 1, reason: 'Owner request' },
        'agent'
      ),
    /owner/
  );
  h.write('opportunity-override', {
    id: 'c',
    priority: 1,
    reason: 'Review missing data first'
  });
  assert.equal(
    h.read('opportunity-rank', { category: 'recurring' }).opportunities[0].id,
    'a'
  );
  assert.throws(
    () => h.read('opportunity-rank', { weights: { bogus: 0 } }),
    /weight/
  );
});

test('managed local publishing enforces rights, scoped grants, and edition-specific owner approval at Studio entry points', async (t) => {
  const h = workspace(t);
  await h.studio.work();
  h.register();
  h.doc();
  assert.throws(() => h.product(), /scope.*draft/);
  h.grant('draft');
  const p = h.product();
  await h.studio.work();
  h.study();
  h.finding('study', 'one');
  h.write('opportunity-record', {
    id: 'guide',
    study: 'study',
    category: 'recurring',
    title: 'Guide',
    forecast: {},
    evidence: h.src('forecast')
  });
  h.plan(p);
  assert.throws(() => h.approve(), /rights/);
  h.approveDoc();
  assert.throws(() => h.approve(), /publish-local/);
  h.grant('publish-local');
  assert.throws(
    () => h.studio.review({ product: p, decision: 'approve' }),
    /owner approval/
  );
  assert.throws(
    () =>
      h.write(
        'experiment-approve',
        { id: 'edition', note: 'self approval' },
        'agent'
      ),
    /owner/
  );
  h.approve();
  h.studio.review({
    product: p,
    decision: 'revise',
    note: 'Clarify the first sentence'
  });
  await h.studio.work();
  assert.equal(h.read().experiments.edition.state, 'stopped');
  h.plan(p, 'revised');
  h.approve('revised');
  h.studio.review({ product: p, decision: 'approve' });
  h.studio.order({
    reference: 'paid',
    product: p,
    buyer: 'fixture',
    paidMinor: 500,
    currency: 'USD'
  });
  const worker = await h.studio.work(async (kindModel, kind, input) => {
    h.write('channel-revoke', {
      scope: 'publish-local',
      reason: 'Review ownership'
    });
    return fixtureWriter(kind, input);
  });
  assert.equal(worker.status, 'stopped');
  assert.equal(Object.keys(h.studio.status().posts).length, 0);
  assert.equal(h.read().experiments.revised.state, 'rolled-back');
  assert.throws(
    () =>
      h.studio.order({
        reference: 'new',
        product: p,
        buyer: 'fixture',
        paidMinor: 500,
        currency: 'USD'
      }),
    /active product|scope/
  );
  const delivery = h.studio.deliver({ reference: 'paid' });
  assert.ok(delivery);
  assert.ok(
    fs.existsSync(
      path.join(
        h.dir,
        'deliveries',
        Object.values(h.studio.status().orders)[0].id + '.md'
      )
    )
  );
});

test('growth samples compare against baseline, survive duplicate delivery and apply rollback with overdue owner obligations', async (t) => {
  const h = workspace(t),
    p = await h.ready();
  await h.studio.work();
  h.doc('renewal', 'obligation', h.now + minute);
  h.approveDoc('renewal');
  const startAt = h.now;
  h.advance(2 * minute + 1);
  const observation = {
    id: 'edition',
    trials: 10,
    successes: 2,
    startAt,
    endAt: h.now,
    ownerMinutes: 2,
    costMinor: 1,
    maintenance: 'Measured local support and review time.',
    evidence: h.src('window')
  };
  const before = h.read();
  assert.equal(
    before.health.scheduledFor,
    before.registration.registeredAt + 2 * minute
  );
  assert.ok(
    before.alerts.some((a) => a.subject === 'channel:document:renewal')
  );
  const x = h.write('experiment-observe', {
    ...observation,
    requestId: 'single-window'
  });
  assert.equal(x.deltaBps, -3000);
  assert.equal(x.state, 'rolled-back');
  h.reopen();
  assert.deepEqual(
    h.write('experiment-observe', {
      ...observation,
      requestId: 'single-window'
    }),
    x
  );
  assert.throws(
    () => h.write('experiment-observe', observation),
    /Duplicate|overlapping/
  );
  assert.equal(
    h.studio.status().products.find((row) => row.id === p).status,
    'retired'
  );
  assert.throws(
    () =>
      h.write('experiment-decide', {
        id: 'edition',
        decision: 'continue',
        reason: 'Proceed'
      }),
    /Continuation/
  );
  h.write('experiment-decide', {
    id: 'edition',
    decision: 'stop',
    reason: 'Ending below threshold.'
  });
  assert.equal(h.read().experiments.edition.decisions.at(-1).decision, 'stop');
  h.advance(10 * minute);
  h.studio.tick();
  h.studio.tick();
  const after = h.read();
  assert.equal(after.health.missedIntervals, 4);
  assert.equal(
    after.alerts.filter((a) => a.subject === 'channel:document:renewal').length,
    1
  );
});

test('rights renewal dates and elapsed experiment caps gate new orders after a restart', async (t) => {
  const h = workspace(t),
    p = await h.ready();
  await h.studio.work();
  h.write('document-review', {
    id: 'license',
    status: 'approved',
    reviewBy: h.now + minute,
    note: 'Early review due',
    evidence: h.src('rereview')
  });
  h.advance(minute);
  h.reopen();
  assert.throws(
    () =>
      h.studio.order({
        product: p,
        reference: 'late',
        buyer: 'x',
        paidMinor: 500,
        currency: 'USD'
      }),
    /rights/
  );
  h.studio.tick();
  const s = h.read();
  assert.equal(s.experiments.edition.state, 'rolled-back');
  assert.ok(s.alerts.some((a) => a.subject === 'channel:document:license'));
  assert.throws(
    () =>
      h.write('document-review', {
        id: 'license',
        status: 'approved',
        note: 'Renew',
        evidence: h.src('old')
      }),
    /overdue/
  );
  h.write('document-review', {
    id: 'license',
    status: 'approved',
    reviewBy: h.now + minute,
    note: 'New review completed',
    evidence: h.src('new')
  });
  assert.ok(
    !h.read().alerts.some((a) => a.subject === 'channel:document:license')
  );
});

test('measured local rehearsal generates a reviewed edition and can reopen without reseeding', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-preview-rehearsal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = fileURLToPath(
    new URL('../apps/channel-ops/cli.mjs', import.meta.url)
  );
  const run = (cmd) =>
    spawnSync(process.execPath, [cli, dir, cmd], { encoding: 'utf8' });
  const first = run('rehearse');
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.deepEqual(
    [result.baseline, result.observed, result.deltaBps],
    [1, 4, 7500]
  );
  assert.equal(result.actualCustomerSales, 0);
  assert.equal(result.externalPublications, 0);
  assert.deepEqual(result.decisions, ['continue', 'stop']);
  assert.equal(result.endState, 'stopped');
  const status = JSON.parse(run('status').stdout);
  assert.equal(
    status.experiments.edition.approval.digest,
    result.editionDigest
  );
  assert.equal(status.experiments.edition.observations.length, 1);
  assert.match(run('rehearse').stderr, /fresh workspace/);
});

test('adopting a populated Studio preserves paid orders and applies rights to prior editions', async (t) => {
  const h = workspace(t);
  await h.studio.work();
  const product = h.studio.product({
    title: 'Existing edition',
    source: 'Original synthetic article',
    rightsConfirmed: true,
    priceMinor: 200
  }).product;
  await h.studio.work();
  h.studio.review({ product, decision: 'approve' });
  await h.studio.work();
  h.studio.order({
    reference: 'existing',
    product,
    buyer: 'fixture',
    paidMinor: 200,
    currency: 'USD'
  });
  const digest = h.studio.store.read().studio.products[product].digest;
  h.register();
  h.reopen();
  assert.equal(h.studio.status().products[0].status, 'review');
  assert.throws(
    () =>
      h.studio.review({
        product,
        decision: 'revise',
        note: 'Replace original'
      }),
    /new product/
  );
  assert.throws(
    () =>
      h.studio.order({
        reference: 'new',
        product,
        buyer: 'fixture',
        paidMinor: 200,
        currency: 'USD'
      }),
    /active product/
  );
  h.studio.deliver({ reference: 'existing' });
  assert.equal(h.studio.store.read().studio.orders.existing.digest, digest);
  h.grant('publish-local');
  h.doc();
  h.approveDoc();
  const attach = h.write('product-rights', { product, rights: ['license'] });
  assert.deepEqual(attach.rights, ['license']);
  assert.throws(
    () => h.studio.review({ product, decision: 'approve' }),
    /Plan an experiment/
  );
});

test('caps keep actual incurred costs, reject overlap, and accept delayed evidence within the operated window', async (t) => {
  const h = workspace(t);
  await h.ready();
  const from = h.now;
  h.advance(5);
  const spent = h.write('experiment-observe', {
    id: 'edition',
    trials: 2,
    successes: 1,
    startAt: from + 2,
    endAt: h.now,
    ownerMinutes: 1,
    costMinor: 6,
    maintenance: 'Observed receipt',
    evidence: h.src('cost')
  });
  assert.equal(spent.state, 'stopped');
  assert.equal(spent.totals.costMinor, 6);
  h.advance(1000);
  h.write('experiment-observe', {
    id: 'edition',
    trials: 1,
    successes: 1,
    startAt: from,
    endAt: from + 2,
    ownerMinutes: 0,
    costMinor: 0,
    maintenance: 'Delayed earlier observation',
    evidence: h.src('late')
  });
  assert.equal(h.read().experiments.edition.totals.trials, 3);
  assert.throws(
    () =>
      h.write('experiment-observe', {
        id: 'edition',
        trials: 1,
        successes: 0,
        startAt: from + 4,
        endAt: h.now,
        ownerMinutes: 0,
        costMinor: 0,
        maintenance: 'After closure',
        evidence: h.src('future')
      }),
    /window/
  );
  const j = workspace(t);
  const p = await j.ready();
  j.advance(61 * minute);
  j.reopen();
  j.studio.tick();
  assert.equal(
    j.read().experiments.edition.stopReason,
    'Experiment deadline reached'
  );
  assert.equal(j.studio.store.read().studio.products[p].status, 'retired');
});
