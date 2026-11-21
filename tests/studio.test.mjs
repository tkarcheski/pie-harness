import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Studio } from '../apps/studio/channel.mjs';
import { fixtureWriter } from '../apps/studio/writer.mjs';
import { maintain, health } from '../apps/studio/maintenance.mjs';

const cli = fileURLToPath(new URL('../apps/studio/cli.mjs', import.meta.url));
const spec = {
  title: 'Practice guide',
  source: 'Use the supplied checklist once.',
  rightsConfirmed: true,
  priceMinor: 650,
  faq: { question: 'What format?', answer: 'Markdown.' }
};
function make(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-studio-'));
  const time = { now: 10000 };
  const studio = new Studio(dir, { initialize: true, clock: () => time.now });
  t.after(() => {
    studio.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  studio.init({ topic: 'Studio test', audience: 'fixture readers' });
  return { studio, dir, time };
}

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
  const firstFile = studio.deliver({ reference: order.reference }).file;
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
