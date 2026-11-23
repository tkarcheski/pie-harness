import { payloadDigest } from '../local/authority.mjs';
import { canUseAccount } from '../local/connections.mjs';
import { record, requireValue } from '../local/store.mjs';

export const connectorVersion = 1;
const key = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const reference = (s) =>
  typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,191}$/.test(s);

// A provider can complete a request after the owner's access changed. Bind
// acceptance to the same credential revision used to start the request.
export function requireAccountSnapshot(state, account, scope, now) {
  const current = record(state, account.id, 'account', account.owner);
  requireValue(
    current.secretRef === account.secretRef &&
      current.accessRevision === account.accessRevision &&
      canUseAccount(state, current, scope, now),
    'Connector account scope unavailable'
  );
}

export function connectorV1(adapter) {
  const spec = adapter?.manifest;
  requireValue(
    spec?.version === connectorVersion &&
      reference(spec.platform) &&
      spec.idempotency === 'recipient-key' &&
      typeof adapter.send === 'function' &&
      typeof adapter.reconcile === 'function',
    'Connector must implement the version 1 recipient-key protocol'
  );
  return Object.freeze({
    manifest: Object.freeze({ ...spec }),
    async send(bytes, { intent, idempotencyKey, signal }) {
      requireValue(
        Buffer.isBuffer(bytes) && key(idempotencyKey),
        'Invalid effect envelope'
      );
      signal?.throwIfAborted();
      try {
        const receipt = await adapter.send(Buffer.from(bytes), {
          intent,
          idempotencyKey,
          signal
        });
        requireValue(reference(receipt), 'Invalid receipt reference');
        return receipt;
      } catch {
        throw Error('Effect acknowledgment unknown');
      }
    },
    async reconcile(idempotencyKey, { signal } = {}) {
      requireValue(key(idempotencyKey), 'Invalid reconciliation key');
      signal?.throwIfAborted();
      try {
        const r = await adapter.reconcile(idempotencyKey, { signal });
        requireValue(
          ['confirmed', 'absent', 'unknown'].includes(r?.state),
          'Invalid outcome'
        );
        if (r.state === 'unknown') return { state: 'unknown' };
        requireValue(reference(r.reference), 'Missing evidence reference');
        return { state: r.state, reference: r.reference };
      } catch {
        return { state: 'unknown' };
      }
    }
  });
}

export async function reconcileEffect(
  engine,
  owner,
  taskId,
  adapter,
  options = {}
) {
  const s = engine.store.read(),
    task = record(s, taskId, 'task', owner);
  const action = record(s, task.pendingAction, 'action', owner);
  const connector = connectorV1(adapter);
  const account = record(s, action.account, 'account', owner);
  requireValue(
    account.platform === connector.manifest.platform,
    'Connector platform mismatch'
  );
  const authorizeReceipt = (state, now) =>
    requireAccountSnapshot(state, account, action.action, now);
  authorizeReceipt(s, engine.store.clock());
  const outcome = await connector.reconcile(action.idempotencyKey, options);
  if (outcome.state === 'unknown') return outcome;
  return engine.reconcile(
    owner,
    taskId,
    outcome.state === 'confirmed',
    outcome.reference,
    action.id,
    authorizeReceipt
  );
}

// Factory gets a fresh, isolated synthetic recipient. send can lose its first
// acknowledgment after persisting the effect, or fail before dispatch.
export function fixtureConnector({ fault = 'none' } = {}) {
  requireValue(
    ['none', 'before-write', 'after-write'].includes(fault),
    'Invalid fixture fault'
  );
  const receipts = new Map();
  let injected = false;
  return {
    manifest: {
      version: 1,
      platform: 'synthetic',
      idempotency: 'recipient-key'
    },
    async send(bytes, { idempotencyKey }) {
      const digest = payloadDigest(bytes),
        prior = receipts.get(idempotencyKey);
      if (prior) {
        requireValue(prior.digest === digest, 'Conflicting effect payload');
        return prior.reference;
      }
      if (!injected && fault === 'before-write') {
        injected = true;
        throw Error('Fixture disconnected');
      }
      const entry = { digest, reference: 'receipt:' + idempotencyKey };
      receipts.set(idempotencyKey, entry);
      if (!injected && fault === 'after-write') {
        injected = true;
        throw Error('Fixture disconnected');
      }
      return entry.reference;
    },
    async reconcile(id) {
      return receipts.has(id)
        ? { state: 'confirmed', reference: receipts.get(id).reference }
        : { state: 'absent', reference: 'lookup:' + id };
    },
    countEffects: () => receipts.size
  };
}

export async function checkConformance(factory) {
  const bytes = Buffer.from('synthetic fixture'),
    idempotencyKey = payloadDigest(bytes),
    pass = [];
  for (const fault of ['none', 'before-write', 'after-write']) {
    const adapter = await factory({ fault });
    const connector = connectorV1(adapter);
    const envelope = { intent: 'synthetic-intent', idempotencyKey };
    requireValue(
      (await connector.reconcile(idempotencyKey)).state === 'absent',
      'New fixture has prior state'
    );
    let receipt;
    try {
      receipt = await connector.send(bytes, envelope);
    } catch {}
    requireValue(
      Boolean(receipt) === (fault === 'none'),
      'Unexpected acknowledgment under ' + fault
    );
    const outcome = await connector.reconcile(idempotencyKey);
    requireValue(
      outcome.state === (fault === 'before-write' ? 'absent' : 'confirmed'),
      'Reconciliation misreported ' + fault
    );
    const recovered = await connector.send(bytes, envelope);
    requireValue(
      (fault === 'before-write' || outcome.reference === recovered) &&
        (await connector.send(bytes, envelope)) === recovered,
      'Retry produced a different receipt'
    );
    let rejected = false;
    try {
      await connector.send(Buffer.from('different synthetic bytes'), envelope);
    } catch {
      rejected = true;
    }
    requireValue(
      rejected &&
        (await adapter.countEffects()) === 1 &&
        (await connector.reconcile(idempotencyKey)).reference === recovered,
      'Conflicting key or duplicate recipient effect'
    );
    pass.push(fault);
  }
  return { version: connectorVersion, passed: pass };
}
