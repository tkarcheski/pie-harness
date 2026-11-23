import { createHash, randomUUID } from 'node:crypto';
import { insert, record, requireValue } from './store.mjs';
import { budgetGate, raiseAlert, resolveAlerts } from './operations.mjs';
import { accountPaused, canUseAccount } from './connections.mjs';

const refPattern = /^secret-ref:[a-zA-Z0-9._/-]+$/;
const connectionReview = 'Check connection, grant and secret reference';
const exact = (object, keys) =>
  Object.keys(object).every((key) => keys.includes(key));
export const payloadDigest = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

export class Accounts {
  constructor(store) {
    this.store = store;
  }
  register(owner, metadata) {
    const keys = [
      'business',
      'recoveryOwner',
      'platform',
      'scopes',
      'expiresAt',
      'secretRef'
    ];
    requireValue(
      exact(metadata, keys) &&
        refPattern.test(metadata.secretRef) &&
        typeof metadata.platform === 'string' &&
        metadata.platform.length &&
        Array.isArray(metadata.scopes) &&
        metadata.scopes.length &&
        metadata.scopes.every((s) => typeof s === 'string' && s.length) &&
        Number.isSafeInteger(metadata.expiresAt),
      'Invalid account metadata'
    );
    return this.store.change((state, now) =>
      insert(state, 'account', owner, { ...metadata, revoked: false }, now)
    );
  }
  rotate(owner, id, ref) {
    requireValue(refPattern.test(ref), 'Expected opaque secret reference');
    this.store.change((state) => {
      const account = record(state, id, 'account', owner);
      account.secretRef = ref;
      account.accessRevision = (account.accessRevision ?? 0) + 1;
    });
  }
  revoke(owner, id) {
    this.store.change((state, time) => {
      const account = record(state, id, 'account', owner);
      if (account.revoked) return;
      account.revoked = true;
      state.ownerTasks.push({
        owner,
        account: id,
        time,
        reason: 'Review revoked account'
      });
    });
  }
  // Only the trusted connector receives a resolved value. Provider and adapter
  // exceptions may contain credentials and must never reach a log or caller.
  async probe(owner, id, scope, provider, verify) {
    const first = this.store.read();
    const account = record(first, id, 'account', owner);
    if (!account.scopes.includes(scope)) return false;
    const available = (state, now) => {
      const current = record(state, id, 'account', owner);
      return (
        current.secretRef === account.secretRef &&
        current.accessRevision === account.accessRevision &&
        canUseAccount(state, current, scope, now)
      );
    };
    try {
      requireValue(available(first, this.store.clock()), 'Unavailable');
      const secret = await provider.resolve(account.secretRef);
      requireValue(
        typeof secret === 'string' && secret.length > 0,
        'Unavailable'
      );
      requireValue(
        available(this.store.read(), this.store.clock()),
        'Unavailable'
      );
      requireValue((await verify(secret)) === true, 'Unavailable');
      this.store.change((s, time) => {
        requireValue(available(s, time), 'Unavailable');
        for (const task of s.ownerTasks) {
          if (
            task.owner === owner &&
            task.account === id &&
            task.reason === connectionReview &&
            (task.scope === scope || task.scope === undefined) &&
            task.resolvedAt === undefined
          )
            task.resolvedAt = time;
        }
        const outstanding = s.ownerTasks.some(
          (t) =>
            t.owner === owner &&
            t.account === id &&
            t.reason === connectionReview &&
            t.resolvedAt === undefined
        );
        if (!outstanding) resolveAlerts(s, owner, id, time, ['connection']);
      });
      return true;
    } catch {
      this.store.change((state, time) => {
        raiseAlert(state, owner, 'connection', id, time);
        const reason = connectionReview;
        if (
          !state.ownerTasks.some(
            (t) =>
              t.owner === owner &&
              t.account === id &&
              t.reason === reason &&
              t.scope === scope &&
              t.resolvedAt === undefined
          )
        )
          state.ownerTasks.push({
            owner,
            account: id,
            scope,
            time,
            reason
          });
      });
      return false;
    }
  }
}

export class DevelopmentSecrets {
  #values = new Map();
  set(ref, value) {
    requireValue(refPattern.test(ref), 'Invalid reference');
    this.#values.set(ref, value);
  }
  resolve(ref) {
    return this.#values.get(ref);
  }
}

const policyVersion = 1;
function validateRequest(state, owner, r) {
  requireValue(
    exact(r, [
      'actor',
      'account',
      'action',
      'object',
      'digest',
      'amountMinor',
      'currency',
      'policyVersion'
    ]) &&
      typeof r.action === 'string' &&
      r.action.length > 0 &&
      typeof r.object === 'string' &&
      r.object.length > 0 &&
      /^[0-9a-f]{64}$/.test(r.digest) &&
      Number.isSafeInteger(r.amountMinor) &&
      r.amountMinor >= 0 &&
      /^[A-Z]{3}$/.test(r.currency) &&
      r.policyVersion === policyVersion,
    'Malformed effect request'
  );
  const actor = record(state, r.actor, 'agent', owner);
  const account = record(state, r.account, 'account', owner);
  requireValue(
    actor.business === account.business,
    'Cross-business effect request'
  );
  return account;
}
const boundKeys = [
  'actor',
  'account',
  'action',
  'object',
  'digest',
  'amountMinor',
  'currency',
  'policyVersion'
];
function outcome(state, owner, now, request, decision, reason, task) {
  const event = {
    owner,
    time: now,
    decision,
    reason,
    type: 'authorization',
    ...(task && { task: task.id, attempt: task.lease.attempt })
  };
  // Store only validated request attributes. Invalid proposals get a reason only.
  if (request)
    Object.assign(
      event,
      Object.fromEntries(
        ['actor', 'account', 'currency', 'amountMinor'].map((key) => [
          key,
          request[key]
        ])
      )
    );
  state.events.push(event);
  return { decision, reason };
}

export function authorize(state, now, owner, r, task) {
  let account;
  try {
    account = validateRequest(state, owner, r);
  } catch {
    return outcome(
      state,
      owner,
      now,
      null,
      'deny',
      'Invalid or cross-scope proposal',
      task
    );
  }
  const decide = (decision, reason) =>
    outcome(state, owner, now, r, decision, reason, task);
  if (accountPaused(state, account)) return decide('deny', 'Paused');
  if (!canUseAccount(state, account, r.action, now))
    return decide('deny', 'Account scope unavailable');
  const approval = state.approvals.find(
    (a) =>
      a.owner === owner &&
      !a.used &&
      (a.revision ?? 0) === (account.accessRevision ?? 0) &&
      a.expiresAt > now &&
      boundKeys.every((k) => a.request[k] === r[k])
  );
  const grants = state.grants.filter(
    (g) =>
      g.owner === owner &&
      g.actor === r.actor &&
      g.account === r.account &&
      g.action === r.action &&
      g.currency === r.currency &&
      g.validFrom <= now &&
      now < g.expiresAt
  );
  if (!approval && !grants.length)
    return decide('deny', 'No matching standing grant');
  if (!approval && !grants.some((g) => r.amountMinor <= g.limitMinor))
    return decide('require-owner', 'Outside standing limit');
  const budgetReason = task && budgetGate(state, task, r);
  if (budgetReason) return decide('require-owner', budgetReason);
  if (approval) approval.used = true;
  return decide(
    'allow',
    approval ? 'Exact owner approval' : 'Within standing limit'
  );
}

// This is the trusted owner-side API. The worker interface exposes no grant,
// approval or pause mutators. Deployments must authenticate owner commands.
export class OwnerPolicy {
  constructor(store) {
    this.store = store;
  }
  grant(owner, grant) {
    return this.store.change((state, now) => {
      const actor = record(state, grant.actor, 'agent', owner);
      const account = record(state, grant.account, 'account', owner);
      requireValue(
        exact(grant, [
          'actor',
          'account',
          'action',
          'currency',
          'limitMinor',
          'validFrom',
          'expiresAt'
        ]) &&
          actor.business === account.business &&
          canUseAccount(state, account, grant.action, now) &&
          /^[A-Z]{3}$/.test(grant.currency) &&
          Number.isSafeInteger(grant.limitMinor) &&
          grant.limitMinor >= 0 &&
          Number.isSafeInteger(grant.validFrom) &&
          Number.isSafeInteger(grant.expiresAt) &&
          grant.expiresAt > Math.max(now, grant.validFrom),
        'Invalid standing grant'
      );
      const id = randomUUID();
      state.grants.push({ ...grant, owner, id });
      return id;
    });
  }
  approve(owner, request, expiresAt) {
    this.store.change((state, now) => {
      record(state, owner, 'owner');
      const account = validateRequest(state, owner, request);
      requireValue(
        canUseAccount(state, account, request.action, now),
        'Account scope unavailable'
      );
      requireValue(
        expiresAt > now && Number.isSafeInteger(expiresAt),
        'Invalid approval expiry'
      );
      state.approvals.push({
        owner,
        request,
        expiresAt,
        revision: account.accessRevision ?? 0,
        used: false
      });
    });
  }
  revokeGrant(owner, id) {
    this.store.change((state) => {
      record(state, owner, 'owner');
      const match = state.grants.find((g) => g.id === id && g.owner === owner);
      requireValue(match, 'Unknown grant');
      state.grants = state.grants.filter((g) => g !== match);
    });
  }
  resume(owner, scope = owner) {
    this.store.change((state) => {
      record(state, owner, 'owner');
      if (scope !== owner && scope !== '*')
        record(state, scope, 'account', owner);
      state.pauses = state.pauses.filter((key) => key !== scope);
    });
  }
  pause(owner, scope = owner) {
    this.store.change((state) => {
      record(state, owner, 'owner');
      if (scope !== owner && scope !== '*')
        record(state, scope, 'account', owner);
      if (!state.pauses.includes(scope)) state.pauses.push(scope);
    });
  }
}
