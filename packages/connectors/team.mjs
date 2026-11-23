import { payloadDigest } from '../local/authority.mjs';
import { enqueueIn } from '../local/execution.mjs';
import { insert, record, requireValue } from '../local/store.mjs';

const roles = ['planner', 'executor', 'reviewer'];
const ref = (s) =>
  typeof s === 'string' && /^[a-z0-9][a-z0-9:._/-]{0,191}$/i.test(s);
const keyed = (s, owner, key) =>
  s.teams?.find((t) => t.owner === owner && t.key === key);

// Each role is bound to a particular enrolled worker and actor. A single
// machine can run multiple, independently enrolled instances.
export function submitTeam(
  store,
  owner,
  {
    key,
    run,
    budgetRef,
    inputRef,
    members,
    durationMs = 3600000,
    maxAttempts = 3
  }
) {
  requireValue(
    ref(key) && ref(inputRef) && ref(budgetRef),
    'Use stable team and artifact references'
  );
  requireValue(
    Number.isSafeInteger(durationMs) && durationMs > 0 && durationMs <= 3600000,
    'Team deadline exceeds one hour'
  );
  requireValue(
    Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 4,
    'Use one to four attempts per role'
  );
  return store.change((s, now) => {
    const runRecord = record(s, run, 'run', owner);
    const experiment = record(s, runRecord.experiment, 'experiment', owner);
    const scope = record(
      s,
      record(s, experiment.opportunity, 'opportunity', owner).channel,
      'channel',
      owner
    );
    const assignments = roles.map((role) => {
      const { actor, node } = members[role];
      requireValue(
        record(s, actor, 'agent', owner).business === scope.business,
        'Agent belongs to another business'
      );
      const worker = record(s, node, 'node', owner);
      requireValue(!worker.revoked, 'Worker enrollment was revoked');
      return { role, actor, node };
    });
    for (const field of ['actor', 'node'])
      requireValue(
        new Set(assignments.map((m) => m[field])).size === 3,
        'Assign independently enrolled agents to the three roles'
      );
    const fingerprint = payloadDigest(
      JSON.stringify([
        run,
        budgetRef,
        inputRef,
        assignments,
        durationMs,
        maxAttempts
      ])
    );
    const previous = keyed(s, owner, key);
    if (previous) {
      requireValue(
        previous.fingerprint === fingerprint,
        'Conflicting team submission'
      );
      return previous;
    }
    const team = {
      owner,
      key,
      fingerprint,
      inputRef,
      deadline: now + durationMs,
      maxAttempts,
      stages: [],
      handoffs: []
    };
    for (const member of assignments) {
      const task = enqueueIn(s, now, owner, {
        run,
        actor: member.actor,
        capability: 'team.' + member.role + '.' + member.node,
        budgetRef,
        retryLimit: maxAttempts - 1,
        deadline: team.deadline,
        dependsOn: team.stages.slice(-1).map((s) => s.task)
      });
      team.stages.push({ ...member, task: task.id });
    }
    (s.teams ??= []).push(team);
    return team;
  });
}

export function teamPacket(store, owner, key, taskId, worker) {
  const s = store.read(),
    team = keyed(s, owner, key),
    stage = team?.stages.find((stage) => stage.task === taskId);
  requireValue(
    stage && worker.node === stage.node,
    'Worker is not assigned this role'
  );
  const t = record(s, taskId, 'task', owner),
    node = record(s, stage.node, 'node', owner);
  requireValue(
    !node.revoked &&
      payloadDigest(worker.token) === node.keyHash &&
      t.lease?.fence === worker.fence &&
      t.lease?.node === worker.node &&
      t.lease.until > store.clock() &&
      store.clock() < team.deadline &&
      t.attempts <= team.maxAttempts,
    'Inactive team lease'
  );
  const index = team.stages.indexOf(stage);
  requireValue(team.handoffs.length === index, 'Missing prerequisite handoff');
  return {
    role: stage.role,
    actor: stage.actor,
    inputRef: team.inputRef,
    upstream: team.handoffs.slice(),
    deadline: team.deadline,
    attempt: t.attempts
  };
}

export function completeStage(
  engine,
  owner,
  key,
  taskId,
  worker,
  { outputRef, digest, decision }
) {
  requireValue(
    ref(outputRef) && /^[0-9a-f]{64}$/.test(digest),
    'Supply a bounded output reference and SHA-256 digest'
  );
  engine.complete(taskId, worker, (s, now, t, attempt) => {
    const team = keyed(s, owner, key);
    const stage = team?.stages[team.handoffs.length];
    requireValue(
      stage?.task === t.id &&
        stage.node === attempt.node &&
        stage.actor === t.actor &&
        team.deadline > now &&
        t.attempts <= team.maxAttempts,
      'Inactive stage or wrong team member'
    );
    requireValue(
      stage.role === 'reviewer'
        ? ['accept', 'return'].includes(decision)
        : decision === undefined,
      'Only the independent reviewer records a disposition'
    );
    const artifact = insert(
      s,
      'artifact',
      owner,
      { attempt: attempt.id, outputRef, digest },
      now
    );
    t.checkpoint = artifact.id;
    team.handoffs.push({
      role: stage.role,
      actor: t.actor,
      task: t.id,
      attempt: attempt.id,
      artifact: artifact.id,
      outputRef,
      digest,
      at: now,
      ...(decision && { decision })
    });
  });
}
