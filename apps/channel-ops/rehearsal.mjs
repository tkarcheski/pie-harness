import { setTimeout as delay } from 'node:timers/promises';
import { payloadDigest } from '../../packages/local/authority.mjs';
import { deskCommand } from '../../packages/channel-ops/desk.mjs';

export async function runRehearsal(studio) {
  if (studio.store.read().studio)
    throw Error('Use a fresh rehearsal workspace');
  const now = () => studio.store.clock();
  let seq = 0;
  const write = (cmd, input, role = 'owner') =>
    deskCommand(
      studio.store,
      cmd,
      { ...input, requestId: 'rehearsal-' + ++seq },
      role
    );
  const src = (ref, note) => ({ ref, observedAt: now(), note });
  const fields = ['set code', 'collector number', 'storage bin', 'condition'];
  const baseline = 'Enter the set code.';
  const source =
    'Enter the set code and collector number. Mark the condition and storage bin on the receiving slip.';
  const successes = (content) =>
    fields.filter((f) => content.toLowerCase().includes(f)).length;
  async function work(kind) {
    const r = await studio.work();
    if (r.status !== 'done' || r.kind !== kind)
      throw Error('Studio failed ' + kind + ' work');
  }
  studio.init({
    topic: 'Collection Intake',
    audience: 'operators testing a receiving slip',
    model: 'fixture'
  });
  await work('brand');
  write('research-open', {
    id: 'coverage',
    hypothesis:
      'An original receiving slip can state all four required intake fields.',
    criterion:
      'Check the field contract and identify gaps in the previous edition.',
    durationMinutes: 5,
    stepMinutes: 1,
    maxRetries: 1,
    maxAttempts: 3,
    minSources: 2
  });
  for (const [id, claim] of [
    ['field-contract', 'The fixture needs four physical inventory fields.'],
    [
      'old-edition',
      'The previous edition includes ' +
        successes(baseline) +
        ' of four required fields.'
    ]
  ]) {
    const a = write(
      'research-begin',
      { id: 'coverage', question: claim },
      'agent'
    );
    write(
      'research-result',
      {
        id: 'coverage',
        attempt: a.id,
        status: 'supports',
        sourceId: id,
        claim,
        evidence: src('evidence:' + id, claim)
      },
      'agent'
    );
  }
  write('opportunity-record', {
    id: 'intake-guide',
    study: 'coverage',
    title: 'Original collection intake slip',
    category: 'recurring',
    forecast: { ownerMinutes: 10 },
    evidence: src(
      'evidence:time-budget',
      'Ten minutes of owner review was allocated; customer economics are unknown.'
    )
  });
  write('channel-register', {
    personaName: 'Intake editor',
    channelName: 'Internal guide studio',
    ownership: src(
      'evidence:fixture-owner',
      'Isolated internal studio ownership.'
    ),
    healthMinutes: 5
  });
  const end = now() + 3600000;
  for (const scope of ['draft', 'publish-local'])
    write('channel-grant', {
      scope,
      validUntil: end,
      evidence: src('evidence:scope-' + scope, 'Local rehearsal only.')
    });
  write('document-register', {
    id: 'rights',
    type: 'right',
    title: 'Original receiving instructions',
    responsible: 'Rehearsal operator',
    reviewBy: end,
    validUntil: end,
    evidence: src(
      'evidence:source-' + payloadDigest(source),
      'Original input retained in this studio.'
    )
  });
  write('document-review', {
    id: 'rights',
    status: 'approved',
    note: 'Reviewed original wording for the isolated exercise.',
    evidence: src(
      'evidence:fixture-rights-review',
      'Internal publication only.'
    )
  });
  const { product } = studio.product({
    title: 'Collection intake slip',
    source,
    rightsConfirmed: true,
    rights: ['rights'],
    priceMinor: 0
  });
  await work('product');
  const metric =
    'Presence of the four named fields in the published Markdown edition';
  write('experiment-plan', {
    id: 'edition',
    product,
    opportunity: 'intake-guide',
    hypothesis: 'The edition includes all four named fields.',
    metric,
    baseline: {
      trials: fields.length,
      successes: successes(baseline),
      evidence: src('evidence:old-edition', baseline)
    },
    endsAt: end,
    costCapMinor: 0,
    ownerCapMinutes: 10,
    minTrials: 4,
    rollbackBelowBps: 0,
    targetDeltaBps: 5000
  });
  write('experiment-approve', {
    id: 'edition',
    note: 'Approve this exact local fixture edition. No external launch.'
  });
  studio.review({ product, decision: 'approve' });
  await work('campaign');
  const x = deskCommand(studio.store, 'status').experiments.edition;
  if (now() <= x.releasedAt) await delay(2);
  const p = studio.store.read().studio.products[product],
    observed = successes(p.draft.content);
  write('experiment-observe', {
    id: 'edition',
    trials: 4,
    successes: observed,
    startAt: x.releasedAt,
    endAt: now(),
    ownerMinutes: 0,
    costMinor: 0,
    maintenance:
      'Checked all four required fields and inspected the generated edition digest.',
    evidence: src(
      'studio:edition-' + p.digest,
      'Measured the local Markdown edition with SHA-256 ' + p.digest
    )
  });
  write('experiment-decide', {
    id: 'edition',
    decision: 'continue',
    reason:
      'The observed editorial target cleared the continuation threshold within existing caps.'
  });
  write('experiment-decide', {
    id: 'edition',
    decision: 'stop',
    reason:
      'Internal acceptance measurement complete; owner approval for a public launch is outstanding.'
  });
  write('opportunity-settlement', {
    id: 'intake-guide',
    experiment: 'edition',
    costsComplete: true,
    evidence: src(
      'evidence:internal-close',
      'Closed the local-only experiment with no orders or spend.'
    )
  });
  const health = write('health-check', {}),
    status = deskCommand(studio.store, 'status'),
    exp = status.experiments.edition;
  return {
    mode: 'internal synthetic rehearsal',
    externalPublications: 0,
    actualCustomerSales: 0,
    study: status.studies.coverage.status,
    rank: deskCommand(studio.store, 'opportunity-rank').opportunities[0]
      .eligibility,
    product,
    editionDigest: p.digest,
    metric,
    baseline: exp.baseline.successes,
    observed,
    trials: fields.length,
    deltaBps: exp.deltaBps,
    decisions: exp.decisions.map((x) => x.decision),
    endState: exp.state,
    ownerMinutes: exp.totals.ownerMinutes,
    costMinor: exp.totals.costMinor,
    health
  };
}
