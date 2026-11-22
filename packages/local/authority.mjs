import { createHash, randomUUID } from 'node:crypto';
import { insert, record, requireValue } from './store.mjs';
import { budgetGate, raiseAlert, resolveAlerts } from './operations.mjs';

const refPattern = /^secret-ref:[a-zA-Z0-9._/-]+$/;
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
      record(state, id, 'account', owner).secretRef = ref;
    });
  }
  revoke(owner, id) {
    this.store.change((state, time) => {
      record(state, id, 'account', owner).revoked = true;
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
    const account = record(this.store.read(), id, 'account', owner);
    try {
      requireValue(
        !account.revoked &&
          account.expiresAt > this.store.clock() &&
          account.scopes.includes(scope),
        'Unavailable'
      );
      const secret = await provider.resolve(account.secretRef);
      requireValue(
        typeof secret === 'string' && secret.length > 0,
        'Unavailable'
      );
      const current = record(this.store.read(), id, 'account', owner);
      requireValue(
        !current.revoked &&
          current.secretRef === account.secretRef &&
          current.expiresAt > this.store.clock(),
        'Unavailable'
      );
      requireValue((await verify(secret)) === true, 'Unavailable');
      this.store.change((s, time) =>
        resolveAlerts(s, owner, id, time, ['connection'])
      );
      return true;
    } catch {
      this.store.change((state, time) => {
        raiseAlert(state, owner, 'connection', id, time);
        state.ownerTasks.push({
          owner,
          account: id,
          time,
          reason: 'Check connection, grant and secret reference'
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
  if (
    state.pauses.includes('*') ||
    state.pauses.includes(owner) ||
    state.pauses.includes(account.id)
  )
    return decide('deny', 'Paused');
  if (
    account.revoked ||
    account.expiresAt <= now ||
    !account.scopes.includes(r.action)
  )
    return decide('deny', 'Account scope unavailable');
  const approval = state.approvals.find(
    (a) =>
      a.owner === owner &&
      !a.used &&
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
          account.scopes.includes(grant.action) &&
          !account.revoked &&
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
      validateRequest(state, owner, request);
      requireValue(
        expiresAt > now && Number.isSafeInteger(expiresAt),
        'Invalid approval expiry'
      );
      state.approvals.push({ owner, request, expiresAt, used: false });
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
