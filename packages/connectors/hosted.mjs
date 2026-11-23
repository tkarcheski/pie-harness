import { payloadDigest } from '../local/authority.mjs';
import { canUseAccount } from '../local/connections.mjs';
import { record, requireValue } from '../local/store.mjs';
import { requireAccountSnapshot } from './sdk.mjs';

const platform = 'openai-responses';
const states = [
  'queued',
  'in_progress',
  'completed',
  'incomplete',
  'failed',
  'cancelled'
];
const terminal = (status) => states.slice(2).includes(status);
const remoteId = (id) =>
  typeof id === 'string' && /^resp_[a-zA-Z0-9_-]{1,160}$/.test(id);
const findTurn = (s, owner, task) =>
  s.hostedTurns?.find(
    (t) => !t.archived && t.owner === owner && t.task === task
  );

export function serializeTurn({ model, input, maxOutputTokens }) {
  requireValue(
    typeof model === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(model) &&
      typeof input === 'string' &&
      input.trim().length &&
      Buffer.byteLength(input) <= 32000 &&
      Number.isInteger(maxOutputTokens) &&
      maxOutputTokens >= 16 &&
      maxOutputTokens <= 4096,
    'Invalid bounded text turn'
  );
  return JSON.stringify({
    model,
    input,
    max_output_tokens: maxOutputTokens,
    background: true,
    store: true,
    tools: []
  });
}

export class HostedResponses {
  constructor(engine, secrets, { request = fetch } = {}) {
    this.engine = engine;
    this.store = engine.store;
    this.secrets = secrets;
    this.request = request;
  }
  #account(owner, id, scope) {
    const s = this.store.read(),
      a = record(s, id, 'account', owner);
    requireValue(
      a.platform === platform &&
        canUseAccount(s, a, scope, this.store.clock()) &&
        !['*', owner, id].some((k) => s.pauses.includes(k)),
      'Hosted account scope unavailable'
    );
    return a;
  }
  async #call(owner, id, scope, suffix, { method = 'GET', body, signal } = {}) {
    const a = this.#account(owner, id, scope);
    const deadline = AbortSignal.timeout(30000);
    const active = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const secret = await this.secrets.resolve(a.secretRef);
      active.throwIfAborted();
      requireValue(
        typeof secret === 'string' && secret.trim().length,
        'Account unavailable'
      );
      requireAccountSnapshot(this.store.read(), a, scope, this.store.clock());
      const response = await this.request(
        'https://api.openai.com/v1/responses' + suffix,
        {
          method,
          redirect: 'error',
          signal: active,
          headers: {
            Authorization: 'Bearer ' + secret,
            'Content-Type': 'application/json'
          },
          ...(body && { body: JSON.stringify(body) })
        }
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw Error('Unsuccessful response');
      }
      const remote = await response.json();
      active.throwIfAborted();
      requireAccountSnapshot(this.store.read(), a, scope, this.store.clock());
      return { remote, account: a, scope };
    } catch {
      throw Error('Hosted request was not confirmed');
    }
  }
  async submit(owner, taskId, worker, authority, spec, { signal } = {}) {
    const bytes = serializeTurn(spec),
      digest = payloadDigest(bytes);
    requireValue(
      authority.action === 'hosted.turn' &&
        authority.object === spec.model &&
        authority.digest === digest &&
        Number.isSafeInteger(authority.amountMinor) &&
        authority.amountMinor > 0,
      'Bind a paid hosted.turn proposal to the exact model and serialized input'
    );
    const s = this.store.read(),
      task = record(s, taskId, 'task', owner),
      prior = findTurn(s, owner, taskId);
    requireValue(task.actor === authority.actor, 'Wrong submitting actor');
    if (prior && record(s, prior.intent, 'action', owner).status !== 'absent') {
      requireValue(
        prior.digest === digest && prior.account === authority.account,
        'Conflicting hosted submission'
      );
      return {
        task: taskId,
        status: prior.status,
        responseId: prior.responseId
      };
    }
    for (const scope of ['hosted.turn', 'hosted.observe', 'hosted.cancel'])
      this.#account(owner, authority.account, scope);
    requireValue(
      task.deadline > this.store.clock() &&
        task.deadline - this.store.clock() <= 3600000,
      'Hosted task requires an unexpired one-hour deadline'
    );
    return this.engine.dispatchEffect(taskId, worker, authority, bytes, {
      send: async (_bytes, { intent }) => {
        this.store.change((state, now) => {
          const old = findTurn(state, owner, taskId);
          if (old) {
            requireValue(
              record(state, old.intent, 'action', owner).status === 'absent',
              'Hosted turn already exists'
            );
            old.archived = true;
          }
          (state.hostedTurns ??= []).push({
            owner,
            task: taskId,
            account: authority.account,
            model: spec.model,
            intent,
            digest,
            deadline: task.deadline,
            status: 'submission-unknown',
            responseId: null,
            observedAt: now,
            events: []
          });
        });
        const receipt = await this.#call(
          owner,
          authority.account,
          'hosted.turn',
          '',
          {
            method: 'POST',
            body: { ...JSON.parse(bytes), metadata: { pie_intent: intent } },
            signal
          }
        );
        return this.#apply(owner, taskId, receipt).responseId;
      }
    });
  }
  #apply(owner, task, { remote, account, scope }, event) {
    return this.store.change((s, now) => {
      requireAccountSnapshot(s, account, scope, now);
      const t = findTurn(s, owner, task);
      requireValue(
        t &&
          remoteId(remote?.id) &&
          remote?.metadata?.pie_intent === t.intent &&
          (!t.responseId || t.responseId === remote.id) &&
          states.includes(remote.status),
        'Provider response does not match this submission'
      );
      // The service may return a resolved snapshot name for a requested alias.
      if (
        !terminal(t.status) &&
        !(t.status === 'in_progress' && remote.status === 'queued')
      ) {
        t.status = remote.status;
        t.responseId = remote.id;
        t.observedAt = now;
        if (remote.status === 'completed')
          t.outputDigest = payloadDigest(textOutput(remote));
      }
      if (event && !t.events.includes(event)) {
        t.events.push(event);
        if (t.events.length > 128) t.events.shift();
      }
      return {
        task,
        status: t.status,
        responseId: t.responseId,
        outputDigest: t.outputDigest
      };
    });
  }
  async refresh(owner, task, { responseId, eventId, signal } = {}) {
    const t = findTurn(this.store.read(), owner, task);
    requireValue(t, 'Unknown hosted turn');
    const id = t.responseId ?? responseId;
    requireValue(
      remoteId(id) && (!responseId || id === responseId),
      'Supply the original provider response ID'
    );
    let account = this.#account(owner, t.account, 'hosted.observe');
    if (eventId)
      requireValue(
        /^evt_[a-zA-Z0-9_-]{1,160}$/.test(eventId),
        'Invalid callback event ID'
      );
    // A callback supplies only a hint. Fetch authoritative status and intent
    // binding from the provider before accepting a remote ID or transition.
    let result = {
      task,
      status: t.status,
      responseId: t.responseId,
      outputDigest: t.outputDigest
    };
    if (!eventId || !t.events.includes(eventId)) {
      const receipt = await this.#call(
        owner,
        t.account,
        'hosted.observe',
        '/' + id,
        { signal }
      );
      requireValue(
        receipt.remote?.id === id,
        'Provider response ID differs from callback'
      );
      account = receipt.account;
      result = this.#apply(owner, task, receipt, eventId);
    }
    if (
      record(this.store.read(), task, 'task', owner).pendingAction === t.intent
    ) {
      try {
        this.engine.reconcile(owner, task, true, id, t.intent, (s, now) =>
          requireAccountSnapshot(s, account, 'hosted.observe', now)
        );
      } catch (e) {
        if (
          record(this.store.read(), t.intent, 'action', owner).status !==
          'confirmed'
        )
          throw e;
      }
    }
    return result;
  }
  async cancel(owner, task, { signal } = {}) {
    const t = findTurn(this.store.read(), owner, task);
    requireValue(
      t && remoteId(t.responseId),
      'Reconcile submission before canceling'
    );
    this.#account(owner, t.account, 'hosted.cancel');
    if (terminal(t.status))
      return { task, status: t.status, responseId: t.responseId };
    return this.#apply(
      owner,
      task,
      await this.#call(
        owner,
        t.account,
        'hosted.cancel',
        '/' + t.responseId + '/cancel',
        { method: 'POST', signal }
      )
    );
  }
  async supervise(owner, task, options = {}) {
    const t = findTurn(this.store.read(), owner, task);
    requireValue(t, 'Unknown hosted turn');
    return t.deadline <= this.store.clock() && !terminal(t.status)
      ? this.cancel(owner, task, options)
      : this.refresh(owner, task, options);
  }
  async result(owner, task, options = {}) {
    const t = findTurn(this.store.read(), owner, task);
    requireValue(
      t?.status === 'completed',
      'Hosted turn has no completed output'
    );
    const { remote: r, account, scope } = await this.#call(
      owner,
      t.account,
      'hosted.observe',
      '/' + t.responseId,
      options.signal ? { signal: options.signal } : {}
    );
    const text = textOutput(r);
    requireValue(
      r.id === t.responseId &&
        r.status === 'completed' &&
        r.metadata?.pie_intent === t.intent &&
        payloadDigest(text) === t.outputDigest,
      'Output changed since verification'
    );
    requireAccountSnapshot(this.store.read(), account, scope, this.store.clock());
    return text;
  }
}

function textOutput(reply) {
  requireValue(Array.isArray(reply.output), 'Missing hosted output');
  return reply.output
    .filter((item) => item?.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter(
      (chunk) => chunk.type === 'output_text' && typeof chunk.text === 'string'
    )
    .map((chunk) => chunk.text)
    .join('');
}
