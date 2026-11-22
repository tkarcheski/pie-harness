import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Studio } from '../apps/studio/channel.mjs';
import { fixtureWriter } from '../apps/studio/writer.mjs';
import {
  OllamaProvider,
  SingleTurnRuntime
} from '../packages/local/model-runtime.mjs';
import { maintain, health } from '../apps/studio/maintenance.mjs';

const cli = fileURLToPath(new URL('../apps/studio/cli.mjs', import.meta.url));
const spec = {
  title: 'Practice guide',
  source: 'Use the supplied checklist once.',
  rightsConfirmed: true,
  priceMinor: 650,
  faq: { question: 'What format?', answer: 'Markdown.' }
};
function make(t, { runtime, model = 'fixture' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-studio-'));
  const time = { now: 10000 };
  const studio = new Studio(dir, {
    initialize: true,
    clock: () => time.now,
    runtime
  });
  t.after(() => {
    studio.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  studio.init({ topic: 'Studio test', audience: 'fixture readers', model });
  return { studio, dir, time };
}

async function mockOllama(t, handle) {
  const visits = [];
  const server = http.createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const input = JSON.parse(text);
      visits.push({ path: req.url, input });
      handle(req.url, input, res);
    } catch {
      res.writeHead(500).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    return closed;
  });
  const provider = new OllamaProvider({
    origin: 'http://127.0.0.1:' + server.address().port
  });
  return { provider, visits };
}

test('PIE-011 discovers Ollama metadata and runs a Studio job through the provider and runtime', async (t) => {
  const model = 'synthetic:local';
  let info = {
    details: { format: 'gguf' },
    capabilities: ['completion', 'vision']
  };
  const { provider, visits } = await mockOllama(t, (route, input, res) => {
    if (route === '/api/show') return res.end(JSON.stringify(info));
    const answer = fixtureWriter(
      'brand',
      JSON.parse(input.messages[1].content)
    );
    res.end(
      JSON.stringify({
        done: true,
        message: { content: JSON.stringify(answer) }
      })
    );
  });
  assert.deepEqual(await provider.describe(model), {
    model,
    format: 'gguf',
    capabilities: ['completion', 'vision']
  });
  assert.deepEqual(
    visits.map((v) => v.path),
    ['/api/show']
  );

  const runtime = new SingleTurnRuntime(provider);
  const { studio } = make(t, { runtime, model });
  assert.equal((await studio.work()).status, 'done');
  assert.equal(studio.store.read().studio.brand.name, 'Studio test Studio');
  assert.deepEqual(
    visits.map((v) => v.path),
    ['/api/show', '/api/show', '/api/chat']
  );
  const { input } = visits.at(-1);
  assert.equal(input.model, model);
  assert.equal(input.format, 'json');
  assert.equal(input.stream, false);
  assert.deepEqual(
    input.messages.map((m) => m.role),
    ['system', 'user']
  );

  info.capabilities = ['embedding'];
  await assert.rejects(
    runtime.run({ model, messages: [] }),
    /does not support text completion/
  );
  info.remote_model = 'synthetic';
  await assert.rejects(
    runtime.run({ model, messages: [] }),
    /installed local model/
  );
  await assert.rejects(
    provider.describe('synthetic:cloud'),
    /installed local model/
  );
  assert.throws(
    () => new OllamaProvider({ origin: 'http://example.invalid' }),
    /loopback/
  );
  assert.equal(visits.filter((v) => v.path === '/api/chat').length, 1);
  info = { details: { format: 'gguf' } };
  assert.equal((await provider.describe(model)).capabilities, null);
});

test(
  'PIE-011 cancels a live Ollama request, closes its connection and leaves the Studio job retryable',
  { timeout: 10000 },
  async (t) => {
    const started = Promise.withResolvers(),
      disconnected = Promise.withResolvers();
    const { provider } = await mockOllama(t, (route, _input, res) => {
      if (route === '/api/show')
        return res.end(
          JSON.stringify({
            details: { format: 'gguf' },
            capabilities: ['completion']
          })
        );
      res.once('close', disconnected.resolve);
      started.resolve();
    });
    const { studio } = make(t, {
      runtime: new SingleTurnRuntime(provider),
      model: 'synthetic:local'
    });
    const stop = new AbortController();
    const outcome = studio.work(undefined, { signal: stop.signal });
    await started.promise;
    stop.abort(new Error('Operator canceled'));
    const result = await outcome;
    assert.equal(result.status, 'stopped');
    assert.match(result.reason, /Operator canceled/);
    await disconnected.promise;
    assert.equal(studio.store.read().records[result.task].status, 'queued');
    assert.equal(studio.store.read().studio.brand, null);
    await assert.rejects(
      studio.work(undefined, { signal: stop.signal }),
      /Operator canceled/
    );
    assert.equal(studio.store.read().records[result.task].attempts, 1);
  }
);

test('PIE-011 bounds a turn even when an alternate provider stalls', async () => {
  let providerSignal;
  const runtime = new SingleTurnRuntime(
    {
      complete({ signal }) {
        providerSignal = signal;
        return new Promise(() => {});
      }
    },
    { timeoutMs: 30 }
  );
  await assert.rejects(runtime.run({ model: 'synthetic', messages: [] }), {
    name: 'TimeoutError'
  });
  assert.equal(providerSignal.aborted, true);
});

test('CLI operates a complete synthetic channel and preserves state on restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-studio-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (cmd) => {
    const r = spawnSync(process.execPath, [cli, dir, cmd], {
      encoding: 'utf8'
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const demo = run('demo'),
    state = run('status');
  assert.deepEqual(
    state.posts.map((p) => p.kind),
    ['story', 'ad']
  );
  assert.equal(state.inbox.length, 2);
  assert.ok(state.inbox.every((m) => m.status === 'answered'));
  assert.equal(state.outbox.length, 3);
  assert.equal(demo.settlement.differenceMinor, 0);
  assert.match(fs.readFileSync(demo.delivery.file, 'utf8'), /Trail Notebook/);
  assert.match(
    fs.readFileSync(path.join(demo.channel.directory, 'brand.svg'), 'utf8'),
    /<svg/
  );
  assert.equal(
    fs.readdirSync(path.join(demo.channel.directory, 'mail')).length,
    3
  );
});

test('approval gates, retries, retirement and idempotent digital fulfillment', async (t) => {
  const { studio } = make(t);
  await studio.work();
  assert.throws(
    () => studio.product({ ...spec, rightsConfirmed: false }),
    /rights/
  );
  const { product } = studio.product(spec);
  const order = {
    reference: 'order-1',
    product,
    buyer: 'fixture',
    paidMinor: 650,
    currency: 'USD'
  };
  assert.throws(() => studio.order(order), /active/);
  const first = await studio.work(async () => {
    throw Error('Provider interrupted');
  });
  assert.equal(first.status, 'stopped');
  assert.equal((await studio.work()).status, 'done');
  studio.review({ product, decision: 'revise', note: 'Add a practice prompt' });
  await studio.work();
  studio.review({ product, decision: 'approve' });
  await studio.work();
  assert.throws(() => studio.order({ ...order, paidMinor: 400 }), /amount/);
  const original = studio.order(order);
  assert.deepEqual(studio.order(order), {
    order: original.order,
    duplicate: true
  });
  assert.throws(() => studio.order({ ...order, buyer: 'other' }), /replay/);
  const hardLink = t.mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('Hard links unavailable'), { code: 'EPERM' });
  });
  const firstFile = studio.deliver({ reference: order.reference }).file;
  hardLink.mock.restore();
  assert.equal(studio.deliver({ reference: order.reference }).file, firstFile);
  assert.equal(studio.status().outbox.length, 1);
  assert.equal(
    studio.settle({
      reference: order.reference,
      feeMinor: 50,
      refundMinor: 0,
      postedMinor: 590,
      currency: 'USD'
    }).differenceMinor,
    10
  );
  studio.review({ product, decision: 'retire' });
  assert.throws(
    () => studio.order({ ...order, reference: 'order-2' }),
    /active/
  );
  assert.equal(studio.deliver({ reference: order.reference }).file, firstFile);
  fs.writeFileSync(firstFile, 'different content');
  assert.throws(
    () => studio.deliver({ reference: order.reference }),
    /differs/
  );
  assert.equal(fs.readFileSync(firstFile, 'utf8'), 'different content');
});

test('scheduled local campaigns, event deduplication and owner escalation', async (t) => {
  const { studio, time } = make(t);
  await studio.work();
  const { product } = studio.product(spec);
  await studio.work();
  studio.review({ product, decision: 'approve' });
  await studio.work();
  studio.schedule({ product, minutes: 1 });
  time.now += 60001;
  studio.tick();
  studio.tick();
  await studio.work();
  const posts = studio.status().posts;
  assert.deepEqual(
    posts.map((p) => p.chapter),
    [1, 1, 2, 2]
  );
  const event = {
    source: 'comment',
    eventId: 'comment-1',
    from: 'customer',
    body: 'Refund my order',
    post: posts[0].id
  };
  const first = studio.receive(event);
  assert.equal(studio.receive(event).task, first.task);
  assert.throws(() => studio.receive({ ...event, body: 'changed' }), /replay/);
  await studio.work(async () => ({
    body: 'Refund approved',
    disposition: 'reply'
  }));
  assert.equal(studio.status().outbox.length, 0);
  assert.equal(studio.status().inbox[0].status, 'needs-owner');
  studio.resolve({
    message: first.message,
    response: 'We will review this request.'
  });
  assert.equal(studio.status().outbox.length, 1);
  assert.throws(
    () => studio.resolve({ message: first.message, response: 'Second reply' }),
    /intervention/
  );
});

test('malformed model work cannot become an approved product and snapshot restores', async (t) => {
  const { studio, dir, time } = make(t);
  await studio.work();
  const { product } = studio.product(spec);
  await studio.work(async () => ({ title: 'Only a title' }));
  assert.throws(
    () => studio.review({ product, decision: 'approve' }),
    /review/
  );
  await studio.work(async (kindModel, kind, input) =>
    fixtureWriter(kind, input)
  );
  studio.review({ product, decision: 'approve' });
  const backup = maintain(studio);
  assert.equal(health(studio).integrity, 'ok');
  const restore = path.join(dir, 'restored');
  fs.mkdirSync(restore);
  fs.copyFileSync(
    path.join(dir, backup.file),
    path.join(restore, 'studio.sqlite')
  );
  fs.copyFileSync(
    path.join(dir, 'worker.key'),
    path.join(restore, 'worker.key')
  );
  const recovered = new Studio(restore, { clock: () => time.now });
  try {
    assert.equal(recovered.status().products[0].status, 'available');
    assert.equal((await recovered.work()).kind, 'campaign');
    assert.equal(recovered.status().posts.length, 2);
  } finally {
    recovered.close();
  }
});
