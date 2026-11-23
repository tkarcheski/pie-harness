import { randomUUID } from 'node:crypto';
import { insert } from '../local/store.mjs';
import { check, label, key, integer, get, fresh, evidence } from './values.mjs';

const minute = 60000;
const ranges = {
  contributionMinor: [-1000000000, 1000000000],
  cashDays: [0, 3650],
  reliabilityBps: [0, 10000],
  growthBps: [-10000, 1000000],
  ownerMinutes: [0, 525600]
};
const defaultWeights = {
  contributionMinor: 35,
  cashDays: 15,
  reliabilityBps: 20,
  growthBps: 15,
  ownerMinutes: 15
};
function metrics(input) {
  check(
    input &&
      typeof input === 'object' &&
      !Array.isArray(input) &&
      Object.keys(input).every((k) => Object.hasOwn(ranges, k)),
    'Unknown economic metric'
  );
  return Object.fromEntries(
    Object.entries(ranges).map(([k, bounds]) => [
      k,
      input[k] == null ? null : integer(input[k], k, ...bounds)
    ])
  );
}
function finish(run, at, state, reason) {
  run.status = state;
  run.endedAt = at;
  run.stopReason = reason;
  return run;
}
function hasIndependentSupport(findings, minimum) {
  const originsBySource = new Map();
  for (const f of findings) {
    if (f.status !== 'supports') continue;
    if (!originsBySource.has(f.sourceId)) originsBySource.set(f.sourceId, new Set());
    originsBySource.get(f.sourceId).add(f.origin);
  }
  if (originsBySource.size < minimum) return false;

  // Match one independent origin per source. Reassign previous matches when a
  // later source needs an origin that an earlier source can corroborate elsewhere.
  const sourceByOrigin = new Map();
  function match(source, visited) {
    for (const origin of originsBySource.get(source)) {
      if (visited.has(origin)) continue;
      visited.add(origin);
      if (!sourceByOrigin.has(origin) || match(sourceByOrigin.get(origin), visited)) {
        sourceByOrigin.set(origin, source);
        return true;
      }
    }
    return false;
  }
  for (const source of originsBySource.keys()) {
    if (match(source, new Set()) && sourceByOrigin.size >= minimum) return true;
  }
  return false;
}
export function sweepResearch(d, now) {
  for (const r of Object.values(d.studies)) {
    if (r.status !== 'open') continue;
    const attempt = r.attempts.at(-1);
    if (attempt?.status === 'running' && now >= attempt.deadline) {
      attempt.status = 'timed-out';
      attempt.endedAt = attempt.deadline;
    }
    if (now >= r.deadline)
      finish(r, r.deadline, 'inconclusive', 'Job deadline reached');
    else if (
      attempt?.status !== 'running' &&
      r.attempts.filter((a) => ['failed', 'timed-out'].includes(a.status))
        .length > r.maxRetries
    )
      finish(r, attempt.endedAt, 'inconclusive', 'Retry budget exhausted');
    else if (
      r.attempts.length >= r.maxAttempts &&
      attempt?.status !== 'running'
    )
      finish(r, attempt.endedAt, 'inconclusive', 'Attempt cap reached');
  }
}
function caps(o) {
  return {
    duration: integer(o.durationMinutes ?? 60, 'job minutes', 1, 60) * minute,
    step: integer(o.stepMinutes ?? 15, 'attempt minutes', 1, 15) * minute,
    maxRetries: integer(o.maxRetries ?? 2, 'retry cap', 0, 10),
    maxAttempts: integer(o.maxAttempts ?? 6, 'attempt cap', 1, 100),
    minSources: integer(
      o.minSources ?? 2,
      'required independent source IDs',
      1,
      50
    )
  };
}
export function researchCommand(s, d, cmd, o, now) {
  if (cmd === 'research-open') {
    const id = fresh(d.studies, o.id, 'study'),
      policy = caps(o);
    check(
      policy.minSources <= policy.maxAttempts,
      'Source target exceeds available attempts'
    );
    const r = {
      id,
      hypothesis: label(o.hypothesis, 'testable hypothesis'),
      criterion: label(o.criterion, 'evidence criterion'),
      status: 'open',
      openedAt: now,
      deadline: now + policy.duration,
      stepMs: policy.step,
      maxRetries: policy.maxRetries,
      maxAttempts: policy.maxAttempts,
      minSources: policy.minSources,
      attempts: [],
      findings: []
    };
    return (d.studies[id] = r);
  }
  if (cmd === 'opportunity-record') {
    const id = fresh(d.opportunities, o.id, 'opportunity'),
      study = get(d.studies, o.study, 'study');
    check(
      study.status === 'supported',
      'Opportunity requires a supported study'
    );
    check(
      ['recurring', 'liquidity'].includes(o.category),
      'Choose recurring or liquidity'
    );
    const forecast = metrics(o.forecast),
      citation = evidence(o.evidence, now);
    const record = insert(
      s,
      'opportunity',
      s.studio.owner,
      { channel: s.studio.channel, forecast, study: study.id },
      now
    );
    return (d.opportunities[id] = {
      id,
      record: record.id,
      study: study.id,
      title: label(o.title, 'opportunity title'),
      category: o.category,
      forecast,
      forecastEvidence: citation,
      actuals: [],
      override: null
    });
  }
  if (cmd === 'opportunity-actual' || cmd === 'opportunity-settlement') {
    const op = get(d.opportunities, o.id, 'opportunity'),
      src = evidence(o.evidence, now);
    let measured = o.metrics;
    let settlement;
    if (cmd === 'opportunity-settlement') {
      const experiment = get(d.experiments, o.experiment, 'experiment');
      check(
        experiment.opportunity === op.id &&
          experiment.releasedAt != null &&
          experiment.endedAt != null,
        'Choose a closed experiment on this opportunity'
      );
      check(
        experiment.observations.length && o.costsComplete === true,
        'Reconcile channel costs and effort for the interval first'
      );
      const orders = Object.values(s.studio.orders).filter(
        (order) => order.channelExperiment === experiment.id
      );
      check(
        orders.every(
          (order) =>
            order.settlement?.differenceMinor === 0 && order.currency === 'USD'
        ),
        'Resolve missing or discrepant settlements'
      );
      const lastOrder = orders.reduce(
        (latest, order) => Math.max(latest, order.settlement.time),
        experiment.endedAt
      );
      const asOf = experiment.observations.reduce(
        (latest, obs) => Math.max(latest, obs.evidence.observedAt),
        lastOrder
      );
      check(
        src.observedAt >= asOf,
        'The reconciliation evidence predates the outcome'
      );
      const net = orders.reduce(
        (total, order) =>
          integer(
            total + order.settlement.postedMinor,
            'settled receipts',
            0,
            Number.MAX_SAFE_INTEGER
          ),
        0
      );
      measured = {
        contributionMinor: net - experiment.totals.costMinor,
        ownerMinutes: experiment.totals.ownerMinutes
      };
      settlement = {
        experiment: experiment.id,
        settledOrders: orders.length,
        netReceiptsMinor: net,
        otherCostsMinor: experiment.totals.costMinor,
        currency: 'USD'
      };
    }
    const data = metrics(measured);
    check(
      Object.values(data).some((v) => v !== null),
      'Supply at least one measured outcome'
    );
    const prior = op.actuals.find(
      (a) =>
        a.evidence.ref === src.ref && a.evidence.observedAt === src.observedAt
    );
    check(!prior, 'Observation already recorded');
    op.actuals.push({
      metrics: data,
      evidence: src,
      recordedAt: now,
      ...(settlement && { settlement })
    });
    return op;
  }
  if (cmd === 'opportunity-override') {
    const op = get(d.opportunities, o.id, 'opportunity');
    const reason = label(o.reason, 'owner override rationale');
    const decision = {
      priority:
        o.priority === null ? null : integer(o.priority, 'priority', 1, 100),
      reason,
      owner: s.studio.owner,
      at: now
    };
    (op.overrideHistory ??= []).push(decision);
    op.override = decision.priority === null ? null : decision;
    return op;
  }
  const r = get(d.studies, o.id, 'study');
  if (cmd === 'research-get') return r;
  check(r.status === 'open', 'Research already stopped: ' + r.stopReason);
  const last = r.attempts.at(-1);
  if (cmd === 'research-begin') {
    check(last?.status !== 'running', 'An attempt is already in progress');
    const attempt = {
      id: randomUUID(),
      status: 'running',
      startedAt: now,
      deadline: Math.min(r.deadline, now + r.stepMs),
      question: label(o.question, 'question')
    };
    r.attempts.push(attempt);
    return attempt;
  }
  if (cmd === 'research-stop') {
    if (last?.status === 'running') {
      last.status = 'canceled';
      last.endedAt = now;
    }
    return finish(r, now, 'inconclusive', label(o.reason, 'stop reason'));
  }
  check(cmd === 'research-result', 'Unknown research command');
  check(
    last?.status === 'running' && last.id === key(o.attempt),
    'Attempt expired or superseded'
  );
  if (o.status === 'failed') {
    Object.assign(last, {
      status: 'failed',
      endedAt: now,
      reason: label(o.reason, 'failure reason')
    });
  } else {
    check(
      ['supports', 'contradicts', 'uncertain'].includes(o.status),
      'Choose supports, contradicts, uncertain or failed'
    );
    const src = evidence(o.evidence, now),
      sourceId = key(o.sourceId, 'independent source ID');
    const origin = src.ref.startsWith('https://')
      ? new URL(src.ref).hostname.replace(/^www\./, '')
      : src.ref;
    const finding = {
      attempt: last.id,
      status: o.status,
      sourceId,
      origin,
      evidence: src,
      claim: label(o.claim, 'finding')
    };
    r.findings.push(finding);
    Object.assign(last, { status: 'observed', endedAt: now });
    // Contradictory observations remain in the file and require an owner decision.
    if (r.findings.some((f) => f.status === 'contradicts'))
      finish(r, now, 'challenged', 'Counterevidence requires owner review');
    else if (hasIndependentSupport(r.findings, r.minSources))
      finish(
        r,
        now,
        'supported',
        'Required distinct supporting sources reached'
      );
  }
  sweepResearch(d, now);
  return r;
}
function valueScore(k, v) {
  const scores = {
    contributionMinor: v / 10000,
    cashDays: 1 - v / 90,
    reliabilityBps: v / 10000,
    growthBps: v / 10000,
    ownerMinutes: 1 - v / 240
  };
  return Math.min(1, Math.max(0, scores[k]));
}
export function ranking(d, o = {}) {
  const weights = { ...defaultWeights, ...o.weights };
  check(
    Object.keys(weights).every((k) => Object.hasOwn(ranges, k)),
    'Unknown ranking weight'
  );
  const sum = Object.values(weights).reduce(
    (total, w) => total + integer(w, 'metric weight', 0, 1000),
    0
  );
  check(sum > 0, 'Choose a positive metric weight');
  const limits = o.limits ?? {};
  check(
    limits &&
      typeof limits === 'object' &&
      !Array.isArray(limits) &&
      Object.keys(limits).every((k) =>
        ['cashDays', 'ownerMinutes'].includes(k)
      ),
    'Unknown ranking constraint'
  );
  for (const [k, v] of Object.entries(limits)) integer(v, k, ...ranges[k]);
  check(
    !o.category || ['recurring', 'liquidity'].includes(o.category),
    'Invalid category'
  );
  const rows = Object.values(d.opportunities)
    .filter((op) => !o.category || op.category === o.category)
    .map((op) => {
      const actuals = op.actuals
        .slice()
        .sort(
          (a, b) =>
            b.evidence.observedAt - a.evidence.observedAt ||
            b.recordedAt - a.recordedAt
        );
      const components = {},
        missing = [],
        overLimit = [];
      let total = 0;
      for (const [k, weight] of Object.entries(weights)) {
        const obs = actuals.find((a) => a.metrics[k] !== null),
          value = obs ? obs.metrics[k] : op.forecast[k];
        const points =
          value === null ? 0 : (100 * weight * valueScore(k, value)) / sum;
        components[k] = {
          value,
          basis: obs ? 'observed' : value === null ? 'missing' : 'forecast',
          points: Math.round(points * 100) / 100,
          evidence:
            obs?.evidence ?? (value === null ? null : op.forecastEvidence)
        };
        total += points;
        if ((weight > 0 || Object.hasOwn(limits, k)) && value === null)
          missing.push(k);
        if (Object.hasOwn(limits, k) && value !== null && value > limits[k])
          overLimit.push(k);
      }
      return {
        ...op,
        actuals,
        components,
        missing,
        overLimit,
        eligibility: overLimit.length
          ? 'outside-limits'
          : missing.length
            ? 'needs-evidence'
            : 'ready',
        score: Math.round(total * 100) / 100
      };
    });
  const tiers = ['ready', 'needs-evidence', 'outside-limits'];
  rows.sort(
    (a, b) =>
      tiers.indexOf(a.eligibility) - tiers.indexOf(b.eligibility) ||
      (a.override?.priority ?? 101) - (b.override?.priority ?? 101) ||
      b.score - a.score ||
      a.id.localeCompare(b.id)
  );
  return { currency: 'USD', weights, limits, opportunities: rows };
}
