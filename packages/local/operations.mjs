import { randomUUID } from 'node:crypto';
import {
  changeIncident,
  connectionDeadlines,
  expiringConnections
} from './connections.mjs';
import { record, requireValue } from './store.mjs';

const currencyCode = /^[A-Z]{3}$/;
function budgetEntry(s, owner, business, ref, currency) {
  return (s.budgets || []).find(
    (b) =>
      b.owner === owner &&
      b.business === business &&
      b.ref === ref &&
      b.currency === currency
  );
}

// The action record is the reservation. Its recipient-confirmed outcome settles
// that same reservation, including actions written before budgets were introduced.
function balance(s, budget) {
  let reservedMinor = 0,
    spentMinor = 0;
  for (const a of Object.values(s.records)) {
    if (
      a.kind !== 'action' ||
      a.owner !== budget.owner ||
      a.currency !== budget.currency ||
      s.records[a.actor]?.business !== budget.business
    )
      continue;
    const task = s.records[s.records[a.attempt]?.task];
    if (task?.budgetRef !== budget.ref) continue;
    if (a.status === 'pending') reservedMinor += a.amountMinor;
    if (a.status === 'confirmed') spentMinor += a.amountMinor;
  }
  requireValue(
    Number.isSafeInteger(reservedMinor + spentMinor),
    'Budget total exceeds safe integer range'
  );
  return {
    ...budget,
    reservedMinor,
    spentMinor,
    availableMinor: budget.limitMinor - reservedMinor - spentMinor
  };
}

export function budgetGate(s, task, request) {
  if (request.amountMinor === 0) return null;
  const b = budgetEntry(
    s,
    task.owner,
    s.records[task.actor].business,
    task.budgetRef,
    request.currency
  );
  if (!b) return 'Budget needs an owner limit';
  return request.amountMinor > balance(s, b).availableMinor
    ? 'Insufficient available budget'
    : null;
}

export function setBudget(
  store,
  owner,
  { business, ref, currency, limitMinor }
) {
  requireValue(
    typeof ref === 'string' &&
      ref.trim() &&
      currencyCode.test(currency) &&
      Number.isSafeInteger(limitMinor) &&
      limitMinor >= 0,
    'Invalid budget limit'
  );
  return store.change((s, time) => {
    record(s, business, 'business', owner);
    s.budgets ??= [];
    let b = budgetEntry(s, owner, business, ref, currency);
    if (!b) {
      b = { owner, business, ref, currency, limitMinor };
      s.budgets.push(b);
    }
    b.limitMinor = limitMinor;
    const result = balance(s, b);
    requireValue(
      result.availableMinor >= 0,
      'Existing reservations or costs exceed the proposed limit'
    );
    s.events.push({
      type: 'budget-limit',
      owner,
      business,
      currency,
      limitMinor,
      time
    });
    return result;
  });
}

const instructions = {
  budget:
    'Review the aggregate limit or release a reservation with recipient evidence.',
  authorization: 'Review the scoped grant, exact approval or account pause.',
  failed: 'Inspect the failed attempt and decide whether to authorize a retry.',
  blocked: 'Resolve the failed prerequisite or cancel the dependent task.',
  'needs-reconciliation':
    'Check the recipient and reconcile the pending intent before retry.',
  connection: 'Check the connection, account grant and secret reference.',
  'connection-expiry':
    'Review renewal or revoke the expiring grant or account.',
  'connection-incident':
    'Review the incident evidence and authorize restoration when ready.'
};

export function raiseAlert(s, owner, code, subject, at, correlation = {}) {
  s.alerts ??= [];
  let alert = s.alerts.find(
    (a) =>
      a.owner === owner &&
      a.code === code &&
      a.subject === subject &&
      a.status !== 'resolved'
  );
  if (!alert) {
    alert = {
      id: randomUUID(),
      owner,
      code,
      subject,
      action: instructions[code],
      status: 'open',
      firstAt: at,
      occurrences: 0
    };
    s.alerts.push(alert);
  }
  Object.assign(alert, correlation, {
    lastAt: at,
    occurrences: alert.occurrences + 1
  });
  return alert;
}
export function resolveAlerts(s, owner, subject, time, codes) {
  for (const a of s.alerts || [])
    if (
      a.owner === owner &&
      a.subject === subject &&
      a.status !== 'resolved' &&
      (!codes || codes.includes(a.code))
    )
      Object.assign(a, { status: 'resolved', resolvedAt: time });
}

export function resolveFormerTaskAlerts(s, task, time) {
  const obsolete = ['failed', 'blocked', 'needs-reconciliation'].filter(
    (code) => code !== task.status
  );
  resolveAlerts(s, task.owner, task.id, time, obsolete);
}
export function acknowledge(store, owner, id) {
  return store.change((s, time) => {
    const a = s.alerts?.find((e) => e.owner === owner && e.id === id);
    requireValue(a && a.status !== 'resolved', 'No active owner alert');
    if (a.status === 'open') {
      Object.assign(a, { status: 'acknowledged', acknowledgedAt: time });
      s.events.push({ type: 'alert-acknowledged', owner, alert: id, time });
    }
    return a;
  });
}

export function noteOwnerTime(store, owner, { task, minutes, entryId }) {
  requireValue(
    Number.isSafeInteger(minutes) &&
      minutes > 0 &&
      typeof entryId === 'string' &&
      /^[\w-]{1,100}$/.test(entryId),
    'Supply minutes and a unique time entry ID'
  );
  return store.change((s, time) => {
    record(s, task, 'task', owner);
    const prior = s.events.find(
      (e) =>
        e.owner === owner && e.type === 'owner-time' && e.entryId === entryId
    );
    if (prior) {
      requireValue(
        prior.task === task && prior.minutes === minutes,
        'Time entry ID already used'
      );
      return { task, minutes };
    }
    s.events.push({ type: 'owner-time', owner, task, minutes, entryId, time });
    return { task, minutes };
  });
}

export function auditView(store, owner) {
  const s = store.read();
  record(s, owner, 'owner');
  // Legacy transitions carry their ownership through the task. Never project
  // free text, connector payloads, receipt bodies or credentials into the audit.
  const events = s.events
    .filter((e) => (e.owner ?? s.records[e.task]?.owner) === owner)
    .map((e) =>
      Object.fromEntries(
        [
          'type',
          'time',
          'task',
          'attempt',
          'intent',
          'actor',
          'account',
          'from',
          'to',
          'decision',
          'currency',
          'amountMinor',
          'minutes',
          'limitMinor',
          'priority',
          'alert',
          'incident'
        ]
          .filter((k) => Object.hasOwn(e, k))
          .map((k) => [k, e[k]])
      )
    );
  const costs = {};
  for (const a of Object.values(s.records)) {
    if (a.owner !== owner || a.kind !== 'action' || a.status !== 'confirmed')
      continue;
    costs[a.currency] = (costs[a.currency] || 0) + a.amountMinor;
  }
  return {
    events,
    incidents: (s.incidents ?? [])
      .filter((i) => i.owner === owner)
      .map((i) => ({
        id: i.id,
        account: i.account,
        status: i.status,
        reason: i.reason,
        evidenceDigest: i.evidenceDigest,
        openedAt: i.openedAt,
        ...(i.approval && {
          reviewDigest: i.approval.reviewDigest,
          approvedAt: i.approval.approvedAt,
          approvalExpiresAt: i.approval.expiresAt
        }),
        ...(i.restoredAt !== undefined && { restoredAt: i.restoredAt })
      })),
    costsMinorByCurrency: costs,
    ownerMinutes: events.reduce(
      (n, e) => n + (e.type === 'owner-time' ? e.minutes : 0),
      0
    ),
    budgets: (s.budgets || [])
      .filter((b) => b.owner === owner)
      .map((b) => balance(s, b)),
    alerts: (s.alerts || []).filter((a) => a.owner === owner)
  };
}

export function ownerCommand(engine, owner, command, input = {}) {
  switch (command) {
    case 'connection-expiry':
      return engine.store.change((s, now) => {
        record(s, owner, 'owner');
        const deadlines = connectionDeadlines(s, owner);
        const current = new Map(
          deadlines.map((row) => [row.subject, row.expiresAt])
        );
        const rows = expiringConnections(
          deadlines,
          now,
          input.horizonMs ?? 86400000
        );
        // A shorter scan horizon is not evidence of renewal. Adopt the current
        // deadline for legacy alerts whose original deadline was not recorded.
        for (const alert of s.alerts ?? []) {
          if (
            alert.owner !== owner ||
            alert.code !== 'connection-expiry' ||
            alert.status === 'resolved'
          )
            continue;
          const expiresAt = current.get(alert.subject);
          if (
            expiresAt === undefined ||
            (alert.expiresAt !== undefined && alert.expiresAt !== expiresAt)
          )
            resolveAlerts(s, owner, alert.subject, now, ['connection-expiry']);
          else alert.expiresAt = expiresAt;
        }
        for (const row of rows) {
          const last = (s.alerts ?? []).find(
            (a) =>
              a.owner === owner &&
              a.subject === row.subject &&
              a.code === 'connection-expiry' &&
              a.status !== 'resolved'
          );
          if (last?.expiryState !== row.state) {
            if (last?.status === 'acknowledged') {
              last.status = 'open';
              delete last.acknowledgedAt;
            }
            raiseAlert(s, owner, 'connection-expiry', row.subject, now, {
              expiryState: row.state,
              expiresAt: row.expiresAt,
              account: row.account
            });
          }
        }
        return rows;
      });
    case 'connection-suspend':
    case 'connection-approve-restore':
    case 'connection-restore':
      return engine.store.change((s, now) => {
        const item = changeIncident(s, owner, command, input, now);
        const subject = 'incident:' + item.id;
        if (item.status === 'restored')
          resolveAlerts(s, owner, subject, now, ['connection-incident']);
        else if (
          !(s.alerts ?? []).some(
            (a) =>
              a.owner === owner &&
              a.code === 'connection-incident' &&
              a.subject === subject &&
              a.status !== 'resolved'
          )
        )
          raiseAlert(s, owner, 'connection-incident', subject, now, {
            account: item.account
          });
        return item;
      });
    case 'queue':
      return engine.inspect(owner);
    case 'audit':
      return auditView(engine.store, owner);
    case 'budget':
      return setBudget(engine.store, owner, input);
    case 'time':
      return noteOwnerTime(engine.store, owner, input);
    case 'ack':
      return acknowledge(engine.store, owner, input.id);
    case 'rank':
      return engine.rank(owner, input.task, input.priority);
    case 'retry':
      return engine.retry(owner, input.task, input.maximumAttempts);
    case 'cancel':
      return engine.cancel(owner, input.task);
    case 'reconcile':
      requireValue(
        typeof input.intent === 'string' && input.intent,
        'Supply the pending intent ID from the queue'
      );
      return engine.reconcile(
        owner,
        input.task,
        input.confirmed,
        input.evidence,
        input.intent
      );
    default:
      throw Error(
        'Choose queue, audit, budget, time, ack, rank, retry, cancel or reconcile'
      );
  }
}

export function restoreTaskMetadata(s, jobs) {
  for (const [id, job] of Object.entries(jobs || {})) {
    const task = s.records[id];
    if (!task || task.kind !== 'task') continue;
    resolveFormerTaskAlerts(s, task, task.lastProgressAt ?? task.createdAt);
    if (task.deadline == null && Number.isSafeInteger(job.deadline))
      task.deadline = job.deadline;
    if (
      ['failed', 'blocked', 'needs-reconciliation'].includes(task.status) &&
      !s.alerts?.some((a) => a.subject === id && a.code === task.status)
    ) {
      const event = s.events.findLast(
        (e) => e.task === id && e.to === task.status
      );
      raiseAlert(
        s,
        task.owner,
        task.status,
        id,
        event?.time ?? task.createdAt,
        { task: id, intent: task.pendingAction }
      );
    }
  }
}
