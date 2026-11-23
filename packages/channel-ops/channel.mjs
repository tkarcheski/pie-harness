import { payloadDigest } from '../local/authority.mjs';
import { raiseAlert, resolveAlerts } from '../local/operations.mjs';
import { insert, record } from '../local/store.mjs';
import {
  check,
  key,
  label,
  integer,
  time,
  evidence,
  get,
  fresh
} from './values.mjs';
import { sweepResearch } from './research.mjs';

const minute = 60000;
const scopes = ['draft', 'publish-local'];
function scopeActive(s, scope, now) {
  const d = s.channelOps;
  const g = d.grants[scope];
  return (
    g &&
    g.actor === s.studio.actor &&
    g.channel === s.studio.channel &&
    now < g.validUntil &&
    g.revokedAt == null &&
    !s.pauses.includes('*') &&
    !s.pauses.includes(s.studio.owner)
  );
}
function grantCheck(s, scope, now) {
  check(scopeActive(s, scope, now), 'Channel scope is unavailable: ' + scope);
}
function rightCheck(d, ids, now) {
  check(
    Array.isArray(ids) && ids.length,
    'Attach rights evidence to this edition'
  );
  for (const id of ids) {
    const doc = get(d.documents, id, 'rights document');
    check(
      doc.type === 'right' &&
        doc.status === 'approved' &&
        now < doc.validUntil &&
        now < doc.reviewBy,
      'Unresolved or expired rights: ' + id
    );
  }
}
// Studio calls these hooks in its own transaction, including after a writer returns.
function rightsFields(s, rights) {
  check(
    Array.isArray(rights) &&
      rights.length > 0 &&
      rights.length <= 30 &&
      new Set(rights).size === rights.length,
    'Choose distinct rights documents for this product'
  );
  for (const id of rights)
    check(
      get(s.channelOps.documents, id, 'rights document').type === 'right',
      'Expected a rights document'
    );
  return { rights: [...rights], managedChannel: s.studio.channel };
}
export function managedDraft(s, now, rights) {
  if (!s.channelOps?.registration) return {};
  grantCheck(s, 'draft', now);
  return rightsFields(s, rights);
}
export function checkDraftWorker(s, product, now) {
  if (product.managedChannel) grantCheck(s, 'draft', now);
}
function currentTest(s, p) {
  return get(
    s.channelOps.experiments,
    p.channelExperiment,
    'channel experiment'
  );
}
export function replaceDraft(s, p, now) {
  if (!p.channelExperiment) return;
  const x = currentTest(s, p);
  if (x.state === 'planned' || x.state === 'approved')
    stop(s, x, now, 'Owner requested a revised edition', false);
  delete p.channelExperiment;
}
export function authorizeProduct(s, p, now, launch = false) {
  if (!p.managedChannel) return;
  grantCheck(s, 'publish-local', now);
  rightCheck(s.channelOps, p.rights, now);
  check(
    p.channelExperiment,
    'Plan an experiment and approve this edition first'
  );
  const x = currentTest(s, p);
  check(
    x.product === p.id && x.channel === p.managedChannel,
    'Product/channel mismatch'
  );
  check(
    x.state === (launch ? 'approved' : 'running'),
    'Experiment needs current owner approval'
  );
  check(now < x.endsAt, 'Experiment deadline reached');
  check(
    x.approval?.digest === payloadDigest(p.draft.content),
    'Edition differs from approved content'
  );
  if (launch) Object.assign(x, { state: 'running', releasedAt: now });
}
function alert(s, subject, active, now, action) {
  const code = 'channel-review',
    owner = s.studio.owner,
    tag = 'channel:' + subject;
  if (!active) {
    resolveAlerts(s, owner, tag, now, [code]);
    return;
  }
  if (
    !s.alerts?.some(
      (a) =>
        a.subject === tag &&
        a.owner === owner &&
        a.code === code &&
        a.status !== 'resolved'
    )
  ) {
    const row = raiseAlert(s, owner, code, tag, now);
    row.action = action;
  }
}
function stop(s, x, now, reason, rollback) {
  const p = s.studio.products[x.product];
  if (p?.channelExperiment === x.id && p.status === 'available') {
    p.status = 'retired';
    p.nextCampaignAt = null;
    p.intervalMs = 0;
  }
  Object.assign(x, {
    state: rollback ? 'rolled-back' : 'stopped',
    endedAt: now,
    stopReason: reason
  });
  alert(s, 'experiment:' + x.id, true, now, reason);
}
function inspectExperiment(s, x, now) {
  if (!['planned', 'approved', 'running'].includes(x.state)) return;
  if (now >= x.endsAt) {
    stop(s, x, now, 'Experiment deadline reached', false);
    return;
  }
  if (x.state !== 'running') return;
  try {
    authorizeProduct(s, s.studio.products[x.product], now);
  } catch (e) {
    stop(s, x, now, e.message, true);
    return;
  }
  if (s.studio.products[x.product].status !== 'available')
    stop(s, x, now, 'Product retired by operator', false);
}
export function channelTick(s, now, force = false) {
  const d = s.channelOps;
  if (d) sweepResearch(d, now);
  if (!d?.registration) return null;
  for (const x of Object.values(d.experiments)) inspectExperiment(s, x, now);
  for (const doc of Object.values(d.documents)) {
    const needsOwner =
      doc.status !== 'approved' ||
      now >= doc.reviewBy ||
      (doc.validUntil != null && now >= doc.validUntil);
    alert(
      s,
      'document:' + doc.id,
      needsOwner,
      now,
      'Review ' + doc.type + ' ' + doc.title + ' with ' + doc.responsible
    );
  }
  if (force || d.nextHealthAt <= now) {
    // Advance from the previous due time. One check accounts for missed intervals after a restart.
    const interval = d.registration.healthMinutes * minute;
    const due = d.nextHealthAt;
    const n = due <= now ? 1 + Math.floor((now - due) / interval) : 0;
    if (n) d.nextHealthAt = due + n * interval;
    const report = {
      at: now,
      scheduledFor: n ? due : null,
      missedIntervals: Math.max(0, n - 1),
      nextAt: d.nextHealthAt,
      openReviews: (s.alerts ?? []).filter(
        (a) =>
          a.code === 'channel-review' &&
          a.subject !== 'channel:operations' &&
          a.status !== 'resolved'
      ).length,
      openSupport: Object.values(s.studio.messages).filter(
        (m) => m.status === 'needs-owner'
      ).length,
      failedJobs: Object.keys(s.studio.jobs).filter((id) =>
        ['failed', 'blocked', 'needs-reconciliation'].includes(
          s.records[id]?.status
        )
      ).length
    };
    alert(
      s,
      'operations',
      report.openSupport > 0 || report.failedJobs > 0,
      now,
      'Inspect the Studio owner queue and failed work'
    );
    d.health.push(report);
    return report;
  }
  return d.health.at(-1);
}

export function channelCommand(s, d, cmd, o, now) {
  const c = s.studio;
  if (cmd === 'channel-register') {
    check(!d.registration, 'Channel already registered');
    const persona = record(
      s,
      record(s, c.channel, 'channel', c.owner).persona,
      'persona',
      c.owner
    );
    check(persona.business === c.business, 'Cross-business persona');
    d.nextHealthAt = now;
    for (const product of Object.values(c.products)) {
      product.managedChannel = c.channel;
      product.rights = [];
      if (product.status === 'available') {
        product.status = 'review';
        product.intervalMs = 0;
        product.nextCampaignAt = null;
      }
    }
    return (d.registration = {
      owner: c.owner,
      persona: persona.id,
      channel: c.channel,
      personaName: label(o.personaName, 'persona'),
      channelName: label(o.channelName, 'channel name'),
      ownership: evidence(o.ownership, now),
      healthMinutes: integer(
        o.healthMinutes ?? 60,
        'health interval',
        1,
        43200
      ),
      registeredAt: now
    });
  }
  check(d.registration, 'Register the channel first');
  if (cmd === 'product-rights') {
    const p = get(c.products, o.product, 'studio product');
    check(
      ['review', 'queued', 'retired'].includes(p.status),
      'Retire an available edition before changing its rights'
    );
    replaceDraft(s, p, now);
    Object.assign(p, rightsFields(s, o.rights));
    if (p.status === 'retired') p.status = 'review';
    return { product: p.id, rights: p.rights };
  }
  if (cmd === 'channel-grant' || cmd === 'channel-revoke') {
    check(scopes.includes(o.scope), 'Unknown channel scope');
    if (cmd === 'channel-revoke') {
      const grant = get(d.grants, o.scope, 'grant');
      grant.revokedAt = now;
      grant.reason = label(o.reason, 'revocation reason');
      return grant;
    }
    const validUntil = time(o.validUntil, 'grant expiry');
    check(validUntil > now, 'Grant already expired');
    return (d.grants[o.scope] = {
      scope: o.scope,
      owner: c.owner,
      actor: c.actor,
      channel: c.channel,
      validUntil,
      issuedAt: now,
      source: evidence(o.evidence, now)
    });
  }
  if (cmd === 'document-register') {
    const id = fresh(d.documents, o.id, 'document');
    check(
      ['right', 'obligation'].includes(o.type),
      'Choose right or obligation'
    );
    const validUntil =
      o.validUntil == null ? null : time(o.validUntil, 'document expiry');
    check(
      o.type !== 'right' || validUntil !== null,
      'Rights require an expiry'
    );
    return (d.documents[id] = {
      id,
      type: o.type,
      title: label(o.title, 'document title'),
      responsible: label(o.responsible, 'responsible owner'),
      owner: c.owner,
      evidence: evidence(o.evidence, now),
      reviewBy: time(o.reviewBy, 'review deadline'),
      validUntil,
      status: 'pending',
      reviews: []
    });
  }
  if (cmd === 'document-review') {
    const doc = get(d.documents, o.id, 'document');
    check(
      ['approved', 'rejected', 'pending'].includes(o.status),
      'Unknown document disposition'
    );
    const next =
      o.reviewBy == null ? doc.reviewBy : time(o.reviewBy, 'next review');
    if (o.status === 'approved')
      check(
        next > now && (doc.validUntil == null || doc.validUntil > now),
        'Cannot approve expired evidence or an overdue review'
      );
    const review = {
      status: o.status,
      reviewer: c.owner,
      at: now,
      note: label(o.note, 'review rationale'),
      evidence: evidence(o.evidence, now),
      reviewBy: next
    };
    doc.reviews.push(review);
    doc.reviewBy = next;
    doc.status = o.status;
    return doc;
  }
  if (cmd === 'health-check') return channelTick(s, now, true);
  if (cmd === 'experiment-plan') {
    const id = fresh(d.experiments, o.id, 'experiment');
    const p = get(c.products, o.product, 'studio product'),
      op = get(d.opportunities, o.opportunity, 'opportunity');
    check(
      p.managedChannel === c.channel &&
        p.status === 'review' &&
        p.draft &&
        !p.channelExperiment,
      'Choose a managed draft awaiting review'
    );
    const baseline = sample(o.baseline, now);
    check(baseline.trials > 0, 'Baseline needs a positive sample');
    const endsAt = time(o.endsAt, 'experiment deadline');
    check(endsAt > now, 'Choose a future deadline');
    const goals = {
      rollbackBelowBps: integer(
        o.rollbackBelowBps,
        'rollback delta',
        -10000,
        10000
      ),
      targetDeltaBps: integer(o.targetDeltaBps, 'target delta', -10000, 10000)
    };
    check(
      goals.targetDeltaBps >= goals.rollbackBelowBps,
      'Target must be at least the rollback threshold'
    );
    p.channelExperiment = id;
    const core = insert(
      s,
      'experiment',
      c.owner,
      { opportunity: op.record },
      now
    );
    return (d.experiments[id] = {
      id,
      record: core.id,
      channel: c.channel,
      opportunity: op.id,
      product: p.id,
      hypothesis: label(o.hypothesis, 'testable hypothesis'),
      metric: label(o.metric, 'success/trial definition'),
      baseline,
      endsAt,
      costCapMinor: integer(o.costCapMinor, 'cost cap'),
      ownerCapMinutes: integer(o.ownerCapMinutes, 'owner time cap', 1),
      minTrials: integer(o.minTrials, 'minimum trials', 1),
      ...goals,
      state: 'planned',
      createdAt: now,
      observations: [],
      decisions: [],
      totals: { trials: 0, successes: 0, costMinor: 0, ownerMinutes: 0 },
      deltaBps: null
    });
  }
  const x = get(d.experiments, o.id, 'experiment');
  if (cmd === 'experiment-approve') {
    const p = get(c.products, x.product, 'product');
    check(
      x.state === 'planned' && p.status === 'review' && now < x.endsAt,
      'Experiment is unavailable for approval'
    );
    rightCheck(d, p.rights, now);
    grantCheck(s, 'publish-local', now);
    x.approval = {
      owner: c.owner,
      digest: payloadDigest(p.draft.content),
      note: label(o.note, 'release rationale'),
      at: now
    };
    x.state = 'approved';
    return x;
  }
  if (cmd === 'experiment-observe') {
    check(x.releasedAt != null, 'Experiment has never been released');
    const sampleRow = sample(o, now);
    const obs = {
      ...sampleRow,
      startAt: time(o.startAt, 'sample start'),
      endAt: time(o.endAt, 'sample end'),
      ownerMinutes: integer(o.ownerMinutes, 'owner effort'),
      costMinor: integer(o.costMinor, 'incurred costs'),
      maintenance: label(o.maintenance, 'maintenance evidence')
    };
    check(
      obs.startAt >= x.releasedAt &&
        obs.endAt > obs.startAt &&
        obs.endAt <=
          Math.min(x.endedAt ?? now, x.endsAt, obs.evidence.observedAt),
      'Invalid measurement window'
    );
    check(
      !x.observations.some(
        (row) =>
          row.evidence.ref === obs.evidence.ref ||
          (row.endAt > obs.startAt && obs.endAt > row.startAt)
      ),
      'Duplicate or overlapping measurement'
    );
    x.observations.push(obs);
    for (const k of Object.keys(x.totals))
      x.totals[k] = integer(
        x.totals[k] + obs[k],
        'cumulative ' + k,
        0,
        Number.MAX_SAFE_INTEGER
      );
    const { trials, successes, costMinor, ownerMinutes } = x.totals;
    x.deltaBps = trials
      ? Math.round(
          10000 *
            (successes / trials - x.baseline.successes / x.baseline.trials)
        )
      : null;
    if (x.state !== 'running') return x;
    if (trials >= x.minTrials && x.deltaBps < x.rollbackBelowBps)
      stop(
        s,
        x,
        now,
        'Measured success rate fell below rollback threshold',
        true
      );
    else if (
      costMinor > x.costCapMinor ||
      (costMinor > 0 && costMinor === x.costCapMinor) ||
      ownerMinutes >= x.ownerCapMinutes
    )
      stop(s, x, now, 'Cost or owner-time cap reached', false);
    return x;
  }
  if (cmd === 'experiment-decide') {
    check(['stop', 'continue'].includes(o.decision), 'Choose stop or continue');
    if (o.decision === 'continue')
      check(
        x.state === 'running' &&
          x.totals.trials >= x.minTrials &&
          x.deltaBps >= x.targetDeltaBps,
        'Continuation needs measured target and remaining caps'
      );
    const decision = {
      decision: o.decision,
      reason: label(o.reason, 'decision rationale'),
      owner: c.owner,
      at: now,
      observations: x.observations.length
    };
    check(
      !x.decisions.length ||
        x.decisions.at(-1).observations !== decision.observations ||
        x.decisions.at(-1).decision !== decision.decision,
      'Review already recorded for these measurements'
    );
    x.decisions.push(decision);
    if (o.decision === 'stop' && !['rolled-back', 'stopped'].includes(x.state))
      stop(s, x, now, decision.reason, false);
    if (o.decision === 'stop') alert(s, 'experiment:' + x.id, false, now, '');
    return x;
  }
  throw Error('Unknown channel command');
}
function sample(o, now) {
  check(o && typeof o === 'object', 'Supply a counted sample');
  const trials = integer(o.trials, 'sample size');
  return {
    trials,
    successes: integer(o.successes, 'successful trials', 0, trials),
    evidence: evidence(o.evidence, now)
  };
}
