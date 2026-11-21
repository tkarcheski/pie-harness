import { enqueueIn } from './execution.mjs';
import { randomUUID } from 'node:crypto';
import { requireValue } from './store.mjs';

// The transcript is authoritative; transports mirror explicitly scoped rooms.
// Only text is supported in v1. Each logical agent has a stable sender label.
export function appendText(
  studio,
  {
    sender,
    text,
    room = 'operations',
    origin = 'local',
    topic = 'note',
    task = null,
    externalId = null
  }
) {
  requireValue(
    typeof sender === 'string' && sender.length > 0 && sender.length <= 100,
    'Invalid message sender'
  );
  requireValue(
    typeof text === 'string' && text.trim() && text.length <= 1500,
    'Use 1–1500 characters of text'
  );
  requireValue(room === 'operations', 'Unknown operations room');
  studio.transcript ??= [];
  const message = {
    version: 1,
    id: randomUUID(),
    room,
    sender,
    text,
    origin,
    topic,
    task,
    externalId,
    time: Date.now()
  };
  studio.transcript.push(message);
  return message;
}

export function incomingText(
  state,
  input,
  { canAsk = false, time = Date.now() } = {}
) {
  const c = state.studio;
  const m = appendText(c, input);
  const counts = {};
  for (const r of Object.values(state.records))
    if (r.kind === 'task' && r.run === c.run)
      counts[r.status] = (counts[r.status] || 0) + 1;
  if (m.text.trim() === '!pie status') {
    appendText(c, {
      sender: 'operator-assistant',
      topic: 'status',
      text:
        'Queue: ' +
        JSON.stringify(counts) +
        '. Owner reviews: ' +
        Object.values(c.messages).filter((x) => x.status === 'needs-owner')
          .length +
        '.'
    });
  }
  if (canAsk && m.text.startsWith('!pie ask ') && m.text.slice(9).trim()) {
    const pending = Object.entries(c.jobs).some(
      ([id, j]) =>
        j.kind === 'ops' &&
        j.input.sender === m.sender &&
        ['queued', 'running'].includes(state.records[id].status)
    );
    if (!pending) {
      const task = enqueueIn(state, time, c.owner, {
        run: c.run,
        actor: c.actor,
        capability: 'studio',
        budgetRef: 'local-operations',
        retryLimit: 0
      });
      c.jobs[task.id] = {
        kind: 'ops',
        model: c.model,
        deadline: time + 3600000,
        input: {
          sender: m.sender,
          question: m.text.slice(9),
          queue: counts,
          ownerReviews: Object.values(c.messages).filter(
            (x) => x.status === 'needs-owner'
          ).length
        }
      };
      appendText(c, {
        sender: 'coordinator',
        topic: 'handoff',
        task: task.id,
        text: 'Assigned operations question to the local assistant.'
      });
    } else
      appendText(c, {
        sender: 'coordinator',
        text: 'An operations question from this sender is already pending.'
      });
  }
  return m;
}

export function transcript(studio, afterId) {
  const rows = studio.store.read().studio.transcript || [];
  if (!afterId) return rows.slice(-100);
  const start = rows.findIndex((m) => m.id === afterId);
  requireValue(start >= 0, 'Unknown transcript cursor');
  return rows.slice(start + 1, start + 101);
}
