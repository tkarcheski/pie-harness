import { record, requireValue } from './store.mjs';

const reasons = new Set([
  'credential-exposure',
  'unexpected-access',
  'connector-failure'
]);
const evidence = (value) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const incidentKey = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);

export function accountPaused(state, account) {
  return ['*', account.owner, account.id].some((key) =>
    state.pauses.includes(key)
  );
}

export function canUseAccount(state, account, scope, now) {
  return (
    !accountPaused(state, account) &&
    !account.revoked &&
    account.expiresAt > now &&
    account.scopes.includes(scope) &&
    !(state.incidents ?? []).some(
      (i) =>
        i.owner === account.owner &&
        i.account === account.id &&
        i.status !== 'restored'
    )
  );
}

export function connectionDeadlines(state, owner) {
  const accounts = Object.values(state.records).filter(
    (a) => a.owner === owner && a.kind === 'account' && !a.revoked
  );
  const active = new Set(accounts.map((a) => a.id));
  return [
    ...accounts.map((a) => ({
      subject: a.id,
      account: a.id,
      kind: 'account',
      expiresAt: a.expiresAt
    })),
    ...state.grants
      .filter((g) => g.owner === owner && active.has(g.account))
      .map((g) => ({
        subject: g.id,
        account: g.account,
        kind: 'grant',
        expiresAt: g.expiresAt
      }))
  ];
}

export function expiringConnections(deadlines, now, horizonMs) {
  requireValue(
    Number.isSafeInteger(horizonMs) &&
      horizonMs >= 0 &&
      horizonMs <= 30 * 86400000,
    'Use a review window of up to thirty days'
  );
  return deadlines
    .filter((row) => row.expiresAt <= now + horizonMs)
    .map((row) => ({ ...row, state: row.expiresAt <= now ? 'expired' : 'due' }))
    .sort(
      (a, b) => a.expiresAt - b.expiresAt || a.subject.localeCompare(b.subject)
    );
}

export function changeIncident(state, owner, cmd, input, now) {
  const account = record(state, input.account, 'account', owner);
  requireValue(incidentKey(input.id), 'Supply a stable incident ID');
  state.incidents ??= [];
  const previous = state.incidents.find(
    (i) => i.owner === owner && i.id === input.id
  );
  if (cmd === 'connection-suspend') {
    requireValue(
      reasons.has(input.reason) && evidence(input.evidenceDigest),
      'Supply a reason code and SHA-256 evidence digest'
    );
    if (previous) {
      requireValue(
        previous.reason === input.reason &&
          previous.evidenceDigest === input.evidenceDigest &&
          previous.account === account.id,
        'Conflicting incident identity'
      );
      return previous;
    }
    const incident = {
      id: input.id,
      owner,
      account: account.id,
      reason: input.reason,
      evidenceDigest: input.evidenceDigest,
      status: 'suspended',
      openedAt: now
    };
    state.incidents.push(incident);
    // A suspended grant generation cannot authorize a later approval by accident.
    account.accessRevision = (account.accessRevision ?? 0) + 1;
    state.events.push({
      type: 'connection-suspended',
      time: now,
      owner,
      account: account.id,
      incident: incident.id
    });
    return incident;
  }
  requireValue(
    previous && previous.account === account.id,
    'Unknown scoped incident'
  );
  if (cmd === 'connection-approve-restore') {
    requireValue(
      previous.status !== 'restored' &&
        !account.revoked &&
        account.expiresAt > now,
      'Account or incident unavailable'
    );
    requireValue(
      evidence(input.reviewDigest) &&
        Number.isSafeInteger(input.expiresAt) &&
        input.expiresAt > now &&
        input.expiresAt <= Math.min(account.expiresAt, now + 900000),
      'Supply a review digest and approval expiry within fifteen minutes'
    );
    const revision = account.accessRevision ?? 0;
    if (
      previous.approval?.reviewDigest === input.reviewDigest &&
      previous.approval.expiresAt === input.expiresAt &&
      previous.approval.revision === revision
    )
      return previous;
    previous.approval = {
      reviewDigest: input.reviewDigest,
      expiresAt: input.expiresAt,
      approvedAt: now,
      revision
    };
    previous.status = 'approved';
    state.events.push({
      type: 'connection-restoration-approved',
      owner,
      account: account.id,
      incident: previous.id,
      time: now
    });
    return previous;
  }
  requireValue(cmd === 'connection-restore', 'Unknown connection command');
  requireValue(
    evidence(input.reviewDigest) &&
      previous.approval?.reviewDigest === input.reviewDigest,
    'Restoration needs matching owner approval'
  );
  if (previous.status === 'restored') return previous;
  requireValue(
    !account.revoked &&
      account.expiresAt > now &&
      previous.approval.expiresAt > now &&
      previous.approval.revision === (account.accessRevision ?? 0),
    'Restoration approval expired or superseded'
  );
  previous.status = 'restored';
  previous.restoredAt = now;
  state.events.push({
    type: 'connection-restored',
    owner,
    account: account.id,
    incident: previous.id,
    time: now
  });
  return previous;
}
