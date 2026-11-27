import { randomBytes, randomUUID } from 'node:crypto';
import { authorize, payloadDigest } from './authority.mjs';
import { insert, record, requireValue } from './store.mjs';
import {
  raiseAlert,
  resolveAlerts,
  resolveFormerTaskAlerts
} from './operations.mjs';

const tasks = (s) => Object.values(s.records).filter((r) => r.kind === 'task');
function transition(s, t, status, reason, time) {
  if (t.status === status) return;
  s.events.push({
    type: 'transition',
    task: t.id,
    owner: t.owner,
    attempt: t.lease?.attempt ?? t.lastAttempt ?? null,
    intent: t.pendingAction ?? null,
    from: t.status ?? null,
    to: status,
    reason,
    time
  });
  t.status = status;
  t.reason = reason;
  t.lastProgressAt = time;
  resolveFormerTaskAlerts(s, t, time);
  if (['failed', 'blocked', 'needs-reconciliation'].includes(status))
    raiseAlert(s, t.owner, status, t.id, time, {
      task: t.id,
      attempt: t.lastAttempt ?? null,
      intent: t.pendingAction ?? null
    });
  else if (['done', 'canceled', 'queued'].includes(status))
    resolveAlerts(s, t.owner, t.id, time);
}

function settle(s, now) {
  const all = tasks(s);
  for (const t of all) {
    if (t.status !== 'running' || t.lease.until > now) continue;
    const attempt = record(s, t.lease.attempt, 'attempt', t.owner);
    t.lastAttempt = attempt.id;
    attempt.endedAt = now;
    delete t.lease;
    if (t.pendingAction)
      transition(
        s,
        t,
        'needs-reconciliation',
        'Unconfirmed effect; inspect before retry',
        now
      );
    else if (t.attempts >= t.retryLimit + 1)
      transition(s, t, 'failed', 'Retry limit exhausted', now);
    else
      transition(
        s,
        t,
        'queued',
        'Expired lease; replay from safe checkpoint',
        now
      );
  }
  let changed;
  do {
    changed = false;
    for (const t of all.filter(
      (t) => t.status === 'queued' || t.status === 'blocked'
    )) {
      if (t.deadline != null && now >= t.deadline) {
        transition(s, t, 'failed', 'Original task deadline expired', now);
        changed = true;
        continue;
      }
      const blocked = t.dependsOn.some((id) =>
        ['failed', 'canceled', 'blocked'].includes(s.records[id].status)
      );
      if (blocked && t.status === 'queued') {
        transition(s, t, 'blocked', 'Prerequisite failed or canceled', now);
        changed = true;
      } else if (
        !blocked &&
        t.status === 'blocked' &&
        t.reason === 'Prerequisite failed or canceled'
      ) {
        transition(s, t, 'queued', 'Prerequisite available again', now);
        changed = true;
      }
    }
  } while (changed);
}
function authNode(s, id, token) {
  const n = record(s, id, 'node');
  requireValue(
    !n.revoked &&
      typeof token === 'string' &&
      payloadDigest(token) === n.keyHash,
    'Node enrollment rejected'
  );
  return n;
}
function active(s, node) {
  return tasks(s).filter(
    (t) => t.status === 'running' && t.lease.node === node
  );
}
function nodeStatus(s, n, now, ttl) {
  if (n.revoked || n.seenAt === null || now - n.seenAt >= ttl) return 'offline';
  if (n.draining) return 'draining';
  if (!n.healthy || !n.capabilities.some((c) => c.state === 'supported'))
    return 'blocked';
  return active(s, n.id).length ? 'busy' : 'idle';
}
function attemptFor(s, t, worker, now) {
  const n = authNode(s, worker.node, worker.token);
  requireValue(
    t.status === 'running' &&
      t.lease.node === n.id &&
      t.lease.fence === worker.fence &&
      t.lease.until > now,
    'Stale lease'
  );
  return record(s, t.lease.attempt, 'attempt', t.owner);
}

export function enqueueIn(
  s,
  now,
  owner,
  {
    run,
    actor,
    capability,
    budgetRef,
    retryLimit = 0,
    dependsOn = [],
    deadline
  }
) {
  requireValue(
    typeof capability === 'string' &&
      capability &&
      typeof budgetRef === 'string' &&
      budgetRef &&
      Number.isSafeInteger(retryLimit) &&
      retryLimit >= 0 &&
      Array.isArray(dependsOn) &&
      (deadline === undefined || Number.isSafeInteger(deadline)),
    'Invalid task'
  );

  record(s, actor, 'agent', owner);
  const experiment = record(s, run, 'run', owner).experiment;
  for (const id of dependsOn) record(s, id, 'task', owner);
  const task = insert(
    s,
    'task',
    owner,
    {
      run,
      experiment,
      actor,
      capability,
      budgetRef,
      retryLimit,
      ...(deadline !== undefined && { deadline }),
      dependsOn,
      attempts: 0,
      checkpoint: null,
      pendingAction: null
    },
    now
  );
  transition(s, task, 'queued', 'Submitted', now);
  settle(s, now);
  return task;
}

export class Execution {
  constructor(store, { heartbeatMs, leaseMs }) {
    requireValue(
      [heartbeatMs, leaseMs].every((n) => Number.isSafeInteger(n) && n > 0),
      'Invalid timing config'
    );
    this.store = store;
    this.heartbeatMs = heartbeatMs;
    this.leaseMs = leaseMs;
  }
  enroll(owner, capacity = 1) {
    requireValue(
      Number.isSafeInteger(capacity) && capacity > 0,
      'Invalid capacity'
    );
    const token = randomBytes(32).toString('hex');
    return this.store.change((s, now) => {
      const n = insert(
        s,
        'node',
        owner,
        {
          capacity,
          keyHash: payloadDigest(token),
          revoked: false,
          draining: false,
          healthy: false,
          seenAt: null,
          capabilities: []
        },
        now
      );
      return { node: n.id, token };
    });
  }
  revoke(owner, id) {
    this.store.change((s, now) => {
      record(s, id, 'node', owner).revoked = true;
      for (const t of active(s, id)) t.lease.until = now;
      settle(s, now);
    });
  }
  drain(owner, id, enabled = true) {
    this.store.change((s) => {
      record(s, id, 'node', owner).draining = enabled;
    });
  }
  heartbeat(worker, healthy) {
    requireValue(typeof healthy === 'boolean', 'Expected health measurement');
    this.store.change((s, now) => {
      const n = authNode(s, worker.node, worker.token);
      n.seenAt = now;
      n.healthy = healthy;
    });
  }
  // Trusted supervisor records probe evidence independently of worker heartbeats.
  probe(owner, id, capability) {
    const { name, version, state, evidence } = capability;
    requireValue(
      [name, version, evidence].every(
        (v) => typeof v === 'string' && v.length > 0
      ) &&
        ['unknown', 'probed', 'supported', 'degraded', 'unsupported'].includes(
          state
        ),
      'Invalid capability probe'
    );
    this.store.change((s, now) => {
      const n = record(s, id, 'node', owner);
      n.capabilities = n.capabilities.filter((c) => c.name !== name);
      n.capabilities.push({ name, version, state, evidence, observedAt: now });
    });
  }
  inspect(owner) {
    return this.store.change((s, now) => {
      settle(s, now);
      const nodes = Object.values(s.records).filter(
        (n) => n.kind === 'node' && n.owner === owner
      );
      const waitingReason = (t) => {
        if (t.status !== 'queued') return null;
        if (s.pauses.includes('*') || s.pauses.includes(owner))
          return 'Owner paused';
        if (t.dependsOn.some((id) => s.records[id].status !== 'done'))
          return 'Waiting for prerequisites';
        const compatible = nodes.filter((n) =>
          n.capabilities.some(
            (c) => c.name === t.capability && c.state === 'supported'
          )
        );
        if (!compatible.length) return 'No qualified worker';
        const available = compatible.filter((n) =>
          ['idle', 'busy'].includes(nodeStatus(s, n, now, this.heartbeatMs))
        );
        if (!available.length) return 'Qualified workers unavailable';
        return available.every((n) => active(s, n.id).length >= n.capacity)
          ? 'Workers at capacity'
          : 'Ready for dispatch';
      };
      return {
        nodes: nodes.map((n) => ({
          id: n.id,
          state: nodeStatus(s, n, now, this.heartbeatMs),
          capacity: n.capacity,
          seenAt: n.seenAt,
          capabilities: n.capabilities,
          activeTasks: active(s, n.id).map((t) => t.id)
        })),
        tasks: tasks(s)
          .filter((t) => t.owner === owner)
          .sort((a, b) => (b.priority || 0) - (a.priority || 0))
          .map((t) => ({
            id: t.id,
            status: t.status,
            reason: t.reason,
            priority: t.priority || 0,
            deadline: t.deadline ?? null,
            lastProgressAt:
              t.lastProgressAt ??
              s.events.findLast((e) => e.task === t.id)?.time ??
              t.createdAt,
            waitingOn: t.dependsOn.filter(
              (id) => s.records[id].status !== 'done'
            ),
            pendingIntent: t.pendingAction,
            waitingReason: waitingReason(t),
            attempts: t.attempts,
            checkpoint: t.checkpoint
          }))
      };
    });
  }
  enqueue(owner, options) {
    return this.store.change((s, now) => enqueueIn(s, now, owner, options));
  }
  rank(owner, id, priority) {
    requireValue(Number.isSafeInteger(priority), 'Priority must be an integer');
    return this.store.change((s, time) => {
      settle(s, time);
      const t = record(s, id, 'task', owner);
      requireValue(
        ['blocked', 'queued'].includes(t.status),
        'Only waiting tasks can be ranked'
      );
      t.priority = priority;
      s.events.push({ type: 'owner-rank', owner, task: id, time, priority });
      return { task: id, priority };
    });
  }
  retry(owner, id, maximumAttempts) {
    return this.store.change((s, now) => {
      settle(s, now);
      const t = record(s, id, 'task', owner);
      requireValue(
        t.status === 'failed' &&
          !t.pendingAction &&
          !t.cancelRequested &&
          !s.pauses.includes('*') &&
          !s.pauses.includes(owner) &&
          (t.deadline == null || now < t.deadline) &&
          t.dependsOn.every((dep) => s.records[dep].status === 'done'),
        'Owner retry is unavailable under current policy'
      );
      requireValue(
        Number.isSafeInteger(maximumAttempts) &&
          maximumAttempts === t.attempts + 1,
        'Authorize exactly one additional attempt using the current attempt count'
      );
      t.retryLimit = maximumAttempts - 1;
      transition(s, t, 'queued', 'Owner authorized one more attempt', now);
      settle(s, now);
      return { task: id, maximumAttempts };
    });
  }
  dependencies(owner, id, parents) {
    this.store.change((s, now) => {
      const t = record(s, id, 'task', owner);
      requireValue(
        t.status === 'queued' && Array.isArray(parents),
        'Dependencies are fixed after dispatch'
      );
      t.dependsOn = parents;
      const visited = new Set();
      function visit(parent) {
        requireValue(parent !== id, 'Dependency cycle');
        if (visited.has(parent)) return;
        visited.add(parent);
        record(s, parent, 'task', owner).dependsOn.forEach(visit);
      }
      parents.forEach(visit);
      settle(s, now);
    });
  }
  claim(worker, run = null) {
    return this.store.change((s, now) => {
      settle(s, now);
      const n = authNode(s, worker.node, worker.token);
      if (
        !['idle', 'busy'].includes(nodeStatus(s, n, now, this.heartbeatMs)) ||
        active(s, n.id).length >= n.capacity
      )
        return null;
      if (s.pauses.includes('*') || s.pauses.includes(n.owner)) return null;
      const t = tasks(s)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0))
        .find(
          (t) =>
            t.owner === n.owner &&
            (!run || t.run === run) &&
            t.status === 'queued' &&
            t.dependsOn.every((id) => s.records[id].status === 'done') &&
            n.capabilities.some(
              (c) => c.name === t.capability && c.state === 'supported'
            )
        );
      if (!t) return null;
      const a = insert(s, 'attempt', t.owner, { task: t.id, node: n.id }, now);
      t.attempts++;
      t.lastAttempt = a.id;
      t.lease = {
        node: n.id,
        fence: randomUUID(),
        until: Math.min(
          now + this.leaseMs,
          n.seenAt + this.heartbeatMs,
          t.deadline ?? Infinity
        ),
        attempt: a.id
      };
      transition(s, t, 'running', 'Worker claimed lease', now);
      return {
        task: t.id,
        attempt: a.id,
        fence: t.lease.fence,
        checkpoint: t.checkpoint
      };
    });
  }
  renew(id, worker) {
    this.store.change((s, now) => {
      const t = record(s, id, 'task');
      attemptFor(s, t, worker, now);
      const n = record(s, worker.node, 'node');
      requireValue(
        n.healthy && now - n.seenAt < this.heartbeatMs,
        'Unhealthy node'
      );
      t.lease.until = Math.min(
        now + this.leaseMs,
        n.seenAt + this.heartbeatMs,
        t.deadline ?? Infinity
      );
    });
  }
  checkpoint(id, worker, outputRef) {
    requireValue(
      typeof outputRef === 'string' && outputRef.length > 0,
      'Missing artifact reference'
    );
    this.store.change((s, now) => {
      const t = record(s, id, 'task');
      const a = attemptFor(s, t, worker, now);
      requireValue(
        !t.pendingAction,
        'Unconfirmed effect requires reconciliation'
      );
      t.checkpoint = insert(
        s,
        'artifact',
        t.owner,
        { attempt: a.id, outputRef },
        now
      ).id;
      t.lastProgressAt = now;
    });
  }
  beginEffect(id, worker, request) {
    return this.store.change((s, now) => {
      const t = record(s, id, 'task');
      const attempt = attemptFor(s, t, worker, now);
      requireValue(!t.pendingAction, 'Effect already pending');
      if (!request || t.actor !== request.actor) {
        const reason = 'Actor mismatch';
        s.events.push({
          type: 'authorization',
          task: t.id,
          attempt: attempt.id,
          owner: t.owner,
          time: now,
          decision: 'deny',
          reason
        });
        return { decision: 'deny', reason };
      }
      const decision = authorize(s, now, t.owner, request, t);
      if (decision.decision === 'allow') {
        const idempotencyKey = payloadDigest(
          JSON.stringify([
            id,
            request.actor,
            request.account,
            request.action,
            request.object,
            request.digest,
            request.currency,
            request.amountMinor,
            request.policyVersion
          ])
        );
        const intent = insert(
          s,
          'action',
          t.owner,
          {
            ...request,
            attempt: attempt.id,
            status: 'pending',
            idempotencyKey
          },
          now
        );
        t.pendingAction = intent.id;
        t.lastProgressAt = now;
        s.events.push({
          type: 'effect-reserved',
          owner: t.owner,
          task: id,
          attempt: attempt.id,
          intent: intent.id,
          time: now,
          currency: request.currency,
          amountMinor: request.amountMinor
        });
        resolveAlerts(s, t.owner, id, now, ['authorization', 'budget']);
        return { ...decision, intent: intent.id, idempotencyKey };
      }
      const code = decision.reason.toLowerCase().includes('budget')
        ? 'budget'
        : 'authorization';
      raiseAlert(s, t.owner, code, id, now, { task: id, attempt: attempt.id });
      return decision;
    });
  }
  async dispatchEffect(id, worker, request, payload, connector) {
    requireValue(
      typeof payload === 'string' || Buffer.isBuffer(payload),
      'Supply the serialized payload'
    );
    const bytes = Buffer.from(payload);
    requireValue(
      payloadDigest(bytes) === request.digest &&
        typeof connector?.send === 'function',
      'Connector or payload digest mismatch'
    );
    const decision = this.beginEffect(id, worker, request);
    if (decision.decision !== 'allow') return decision;
    let evidence;
    try {
      evidence = await connector.send(bytes, {
        intent: decision.intent,
        idempotencyKey: decision.idempotencyKey
      });
    } catch {
      /* Lost acknowledgments keep the reservation until reconciliation. */
    }
    return this.store.change((s, now) => {
      const t = record(s, id, 'task');
      settle(s, now);
      if (
        t.pendingAction !== decision.intent ||
        t.lease?.fence !== worker.fence
      )
        return {
          intent: decision.intent,
          status: record(s, decision.intent, 'action', t.owner).status
        };
      const a = attemptFor(s, t, worker, now);
      if (typeof evidence === 'string' && evidence.trim()) {
        finishEffect(s, t, true, evidence, now);
        return { intent: decision.intent, status: 'confirmed' };
      }
      a.endedAt = now;
      delete t.lease;
      transition(
        s,
        t,
        'needs-reconciliation',
        'Recipient receipt is unknown',
        now
      );
      return { intent: decision.intent, status: 'pending' };
    });
  }
  fail(id, worker, reason, diagnostic = {}) {
    requireValue(
      typeof reason === 'string' && reason.trim(),
      'Provide a failure reason'
    );
    this.store.change((s, now) => {
      const t = record(s, id, 'task');
      const a = attemptFor(s, t, worker, now);
      a.endedAt = now;
      a.failure = { ...diagnostic, message: reason };
      delete t.lease;
      const next = t.pendingAction
        ? 'needs-reconciliation'
        : t.attempts > t.retryLimit
          ? 'failed'
          : 'queued';
      transition(s, t, next, reason, now);
      settle(s, now);
    });
  }
  complete(id, worker, onComplete = () => {}) {
    this.store.change((s, now) => {
      const t = record(s, id, 'task');
      const a = attemptFor(s, t, worker, now);
      requireValue(!t.pendingAction, 'Reconcile before completion');
      onComplete(s, now, t, a);
      a.endedAt = now;
      delete t.lease;
      transition(s, t, 'done', 'Worker completed', now);
    });
  }
  reconcile(owner, id, confirmed, recordRef, expectedIntent, authorizeReceipt) {
    requireValue(
      typeof confirmed === 'boolean' &&
        typeof recordRef === 'string' &&
        recordRef.trim().length > 0,
      'Missing reconciliation evidence'
    );
    return this.store.change((s, now) => {
      settle(s, now);
      const t = record(s, id, 'task', owner);
      requireValue(
        t.pendingAction &&
          ['running', 'needs-reconciliation'].includes(t.status),
        'No pending effect'
      );
      requireValue(
        expectedIntent === undefined || t.pendingAction === expectedIntent,
        'Reconciliation intent changed'
      );
      authorizeReceipt?.(s, now);
      finishEffect(s, t, confirmed, recordRef, now);
      return { task: id, status: t.status };
    });
  }
  cancel(owner, id) {
    return this.store.change((s, now) => {
      const t = record(s, id, 'task', owner);
      requireValue(
        ['running', 'queued', 'blocked', 'needs-reconciliation'].includes(
          t.status
        ),
        'Task cannot be canceled in this state'
      );
      if (t.lease) record(s, t.lease.attempt, 'attempt', owner).endedAt = now;
      t.cancelRequested = true;
      delete t.lease;
      transition(
        s,
        t,
        t.pendingAction ? 'needs-reconciliation' : 'canceled',
        'Owner canceled',
        now
      );
      settle(s, now);
      return { task: id, status: t.status };
    });
  }
}

function finishEffect(s, t, confirmed, evidence, now) {
  const intent = record(s, t.pendingAction, 'action', t.owner);
  if (t.lease) record(s, t.lease.attempt, 'attempt', t.owner).endedAt = now;
  intent.status = confirmed ? 'confirmed' : 'absent';
  intent.evidence = evidence;
  t.lastAttempt = intent.attempt;
  s.events.push({
    type: confirmed ? 'effect-confirmed' : 'effect-absent',
    owner: t.owner,
    task: t.id,
    intent: intent.id,
    attempt: intent.attempt,
    currency: intent.currency,
    amountMinor: intent.amountMinor,
    time: now
  });
  delete t.lease;
  const next = confirmed
    ? 'done'
    : t.cancelRequested
      ? 'canceled'
      : t.attempts > t.retryLimit
        ? 'failed'
        : 'queued';
  resolveAlerts(s, t.owner, t.id, now, ['needs-reconciliation']);
  transition(s, t, next, 'Recipient evidence reconciled', now);
  t.pendingAction = null;
  settle(s, now);
}
