import { appendText } from '../../packages/local/text-bus.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store, insert, requireValue } from '../../packages/local/store.mjs';
import { payloadDigest } from '../../packages/local/authority.mjs';
import { Execution, enqueueIn } from '../../packages/local/execution.mjs';
import { brandMark, validateDraft, writeDraft } from './writer.mjs';

const timings = { heartbeatMs: 60000, leaseMs: 45000 };
const jobLimit = 3600000,
  stepLimit = 900000;
const text = (v, name, max = 4000) => {
  requireValue(
    typeof v === 'string' && v.trim() && v.length <= max,
    'Invalid ' + name
  );
  return v.trim();
};
function outsideGit(directory) {
  let dir = path.resolve(directory);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  dir = fs.realpathSync(dir);
  while (true) {
    requireValue(
      !fs.existsSync(path.join(dir, '.git')),
      'Place runtime state outside any Git checkout'
    );
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
function item(collection, id, label) {
  requireValue(
    typeof id === 'string' && Object.hasOwn(collection, id),
    'Unknown ' + label
  );
  return collection[id];
}
function addJob(s, now, kind, input, model) {
  const c = s.studio;
  const task = enqueueIn(s, now, c.owner, {
    run: c.run,
    actor: c.actor,
    capability: 'studio',
    budgetRef: 'local-inference-only',
    retryLimit: 1
  });
  c.jobs[task.id] = { kind, input, model, deadline: now + jobLimit };
  appendText(c, {
    sender: 'coordinator',
    topic: 'assignment',
    task: task.id,
    text: 'Queued ' + kind + ' work.'
  });
  return task.id;
}
function money(value) {
  requireValue(
    Number.isSafeInteger(value) && value >= 0 && value <= 100000000,
    'Expected nonnegative USD cents'
  );
  return value;
}

export class Studio {
  constructor(directory, { initialize = false, clock = Date.now } = {}) {
    requireValue(directory, 'Supply a runtime state directory');
    outsideGit(directory);
    this.dir = path.resolve(directory);
    if (initialize) fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.file = path.join(this.dir, 'studio.sqlite');
    requireValue(
      initialize || fs.existsSync(this.file),
      'Initialize this studio first'
    );
    this.store = new Store(this.file, clock);
    this.engine = new Execution(this.store, timings);
  }

  init({ topic, audience, model = 'fixture' }) {
    topic = text(topic, 'brand topic', 100);
    audience = text(audience, 'audience', 200);
    model = text(model, 'model', 200);
    return this.store.change((s, now) => {
      if (s.studio) {
        requireValue(
          s.studio.topic === topic &&
            s.studio.audience === audience &&
            s.studio.model === model,
          'Studio already initialized with a different brief'
        );
        return { brandTask: s.studio.brandTask, existing: true };
      }
      const owner = insert(s, 'owner', null, {}, now).id;
      const business = insert(s, 'business', owner, {}, now).id;
      const persona = insert(s, 'persona', owner, { business }, now).id;
      const actor = insert(s, 'agent', owner, { business }, now).id;
      const channel = insert(
        s,
        'channel',
        owner,
        { business, persona, type: 'digital-products' },
        now
      ).id;
      const opportunity = insert(
        s,
        'opportunity',
        owner,
        { channel, forecast: null },
        now
      ).id;
      const experiment = insert(
        s,
        'experiment',
        owner,
        { opportunity },
        now
      ).id;
      const run = insert(s, 'run', owner, { experiment }, now).id;
      // Credentials live outside both the database and source control. If an
      // initialization transaction crashes before commit, reuse the local key.
      const keyfile = path.join(this.dir, 'worker.key');
      try {
        fs.writeFileSync(keyfile, randomBytes(32).toString('hex'), {
          flag: 'wx',
          mode: 0o600
        });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const key = fs.readFileSync(keyfile, 'utf8');
      requireValue(/^[0-9a-f]{64}$/.test(key), 'Invalid local enrollment key');
      const node = insert(
        s,
        'node',
        owner,
        {
          capacity: 1,
          keyHash: payloadDigest(key),
          revoked: false,
          draining: false,
          healthy: false,
          seenAt: null,
          capabilities: []
        },
        now
      ).id;
      s.studio = {
        owner,
        business,
        actor,
        channel,
        run,
        node,
        topic,
        audience,
        model,
        jobs: {},
        products: {},
        orders: {},
        posts: {},
        messages: {},
        outbox: [],
        brand: null,
        chapter: 0
      };
      const brandTask = addJob(s, now, 'brand', { topic, audience }, model);
      s.studio.brandTask = brandTask;
      return { brandTask, existing: false };
    });
  }

  product({ title, source, rightsConfirmed, priceMinor, faq }) {
    title = text(title, 'title', 200);
    source = text(source, 'source material', 50000);
    money(priceMinor);
    requireValue(rightsConfirmed === true, 'Confirm rights to source material');
    if (faq)
      faq = {
        question: text(faq.question, 'FAQ question'),
        answer: text(faq.answer, 'FAQ answer')
      };
    return this.store.change((s, now) => {
      const c = s.studio;
      requireValue(c.brand, 'Run the brand job first');
      const id = randomUUID();
      const task = addJob(
        s,
        now,
        'product',
        { id, title, source, brand: c.brand.name },
        c.model
      );
      c.products[id] = {
        id,
        title,
        source,
        rightsConfirmed: true,
        priceMinor,
        currency: 'USD',
        faq: faq ?? null,
        status: 'queued',
        task
      };
      return { product: id, task };
    });
  }

  review({ product, decision, note = '' }) {
    requireValue(
      ['approve', 'revise', 'retire'].includes(decision),
      'Unknown review decision'
    );
    return this.store.change((s, now) => {
      const c = s.studio,
        p = item(c.products, product, 'product');
      if (decision === 'retire') {
        requireValue(
          p.status === 'available',
          'Only available products can be retired'
        );
        p.status = 'retired';
        return { product, status: p.status };
      }
      requireValue(
        p.status === 'review',
        'Product is not awaiting owner review'
      );
      p.reviewedAt = now;
      if (decision === 'revise') {
        const feedback = text(note, 'revision feedback');
        const task = addJob(
          s,
          now,
          'product',
          {
            id: product,
            title: p.title,
            source: p.source,
            prior: p.draft.content,
            feedback,
            brand: c.brand.name
          },
          c.model
        );
        p.status = 'queued';
        p.task = task;
        return { product, task, status: p.status };
      }
      p.status = 'available';
      p.digest = payloadDigest(p.draft.content);
      const task = addJob(s, now, 'campaign', { product }, c.model);
      return { product, status: p.status, campaignTask: task };
    });
  }

  campaign({ product }) {
    return this.store.change((s, now) => {
      const c = s.studio,
        p = item(c.products, product, 'product');
      requireValue(
        p.status === 'available',
        'Campaign requires an approved active product'
      );
      return { task: addJob(s, now, 'campaign', { product }, c.model) };
    });
  }

  schedule({ product, minutes }) {
    requireValue(
      Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= 525600,
      'Invalid campaign interval in minutes'
    );
    return this.store.change((s, now) => {
      const p = item(s.studio.products, product, 'product');
      requireValue(
        p.status === 'available',
        'Schedule requires an approved product'
      );
      p.intervalMs = minutes * 60000;
      p.nextCampaignAt = minutes ? now + p.intervalMs : null;
      return { product, nextCampaignAt: p.nextCampaignAt };
    });
  }

  tick() {
    this.store.change((s, now) => {
      const c = s.studio;
      for (const p of Object.values(c.products)) {
        if (p.status !== 'available' || !p.intervalMs || p.nextCampaignAt > now)
          continue;
        const pending = Object.entries(c.jobs).some(
          ([id, j]) =>
            j.kind === 'campaign' &&
            j.input.product === p.id &&
            ['queued', 'running'].includes(s.records[id].status)
        );
        if (!pending) addJob(s, now, 'campaign', { product: p.id }, c.model);
        p.nextCampaignAt = now + p.intervalMs;
      }
    });
  }

  receive({ source, eventId, from, body, product, post }) {
    requireValue(['email', 'comment'].includes(source), 'Use email or comment');
    eventId = text(eventId, 'external event ID', 100);
    from = text(from, 'sender alias', 100);
    body = text(body, 'message', 4000);
    return this.store.change((s, now) => {
      const c = s.studio;
      if (source === 'comment') {
        const parent = item(c.posts, post, 'parent post');
        requireValue(
          !product || product === parent.product,
          'Comment product mismatch'
        );
        product = parent.product;
      }
      const p = item(c.products, product, 'product');
      requireValue(
        ['available', 'retired'].includes(p.status),
        'Product support is not active'
      );
      const key = source + ':' + eventId;
      if (c.messages[key]) {
        const prev = c.messages[key];
        requireValue(
          prev.from === from &&
            prev.body === body &&
            prev.product === product &&
            prev.post === (post ?? null),
          'Conflicting event replay'
        );
        return { message: key, task: prev.task, duplicate: true };
      }
      const task = addJob(s, now, 'reply', { key }, c.model);
      c.messages[key] = {
        key,
        from,
        body,
        source,
        product,
        post: post ?? null,
        receivedAt: now,
        status: 'queued',
        task
      };
      return { message: key, task, duplicate: false };
    });
  }

  resolve({ message, response }) {
    response = text(response, 'owner reply');
    return this.store.change((s, now) => {
      const c = s.studio,
        m = item(c.messages, message, 'message');
      requireValue(
        m.status === 'needs-owner',
        'Message is not awaiting owner intervention'
      );
      this.sendReply(c, m, response, now, 'owner');
      return { message, status: m.status };
    });
  }

  sendReply(c, m, body, time, author) {
    c.outbox.push({
      id: randomUUID(),
      time,
      transport: m.source,
      to: m.from,
      inReplyTo: m.key,
      parentPost: m.post,
      body,
      author
    });
    m.status = 'answered';
    m.answeredAt = time;
  }

  order({ reference, product, buyer, paidMinor, currency }) {
    reference = text(reference, 'order reference', 100);
    buyer = text(buyer, 'buyer alias', 100);
    requireValue(
      /^[\w-]+$/.test(reference),
      'Order reference must be a simple identifier'
    );
    requireValue(
      !Object.hasOwn(Object.prototype, reference),
      'Reserved order reference'
    );
    money(paidMinor);
    return this.store.change((s, now) => {
      const c = s.studio,
        p = item(c.products, product, 'product');
      if (Object.hasOwn(c.orders, reference)) {
        const existing = c.orders[reference];
        requireValue(
          existing.product === product &&
            existing.buyer === buyer &&
            existing.paidMinor === paidMinor &&
            existing.currency === currency,
          'Conflicting order replay'
        );
        return { order: existing.id, duplicate: true };
      }
      requireValue(
        p.status === 'available' &&
          currency === 'USD' &&
          paidMinor === p.priceMinor,
        'Check active product, currency and payment amount'
      );
      const id = randomUUID();
      c.orders[reference] = {
        id,
        product,
        buyer,
        currency,
        paidMinor,
        observedAt: now,
        digest: p.digest,
        status: 'paid',
        settlement: null
      };
      return { order: id, duplicate: false };
    });
  }

  deliver({ reference }) {
    // A crash between file creation and DB commit can replay the identical
    // immutable delivery. Only the committed transaction appends the envelope.
    return this.store.change((s, now) => {
      const c = s.studio,
        o = item(c.orders, reference, 'order'),
        p = item(c.products, o.product, 'product');
      requireValue(
        o.digest === payloadDigest(p.draft.content),
        'Delivery digest mismatch'
      );
      const dir = path.join(this.dir, 'deliveries');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const target = path.join(dir, o.id + '.md');
      if (!fs.existsSync(target)) {
        const temp = path.join(dir, randomUUID() + '.tmp');
        try {
          fs.writeFileSync(temp, p.draft.content, { flag: 'wx', mode: 0o600 });
          fs.linkSync(temp, target);
        } finally {
          if (fs.existsSync(temp)) fs.unlinkSync(temp);
        }
      }
      requireValue(
        payloadDigest(fs.readFileSync(target)) === o.digest,
        'Existing delivery differs'
      );
      if (o.status === 'paid') {
        o.status = 'delivered';
        o.deliveredAt = now;
        c.outbox.push({
          id: randomUUID(),
          transport: 'email',
          to: o.buyer,
          attachment: o.id + '.md',
          digest: o.digest,
          time: now,
          body: 'Your copy of ' + p.title + ' is ready.'
        });
      }
      return { order: o.id, status: o.status, file: target };
    });
  }

  settle({ reference, feeMinor, refundMinor, postedMinor, currency }) {
    [feeMinor, refundMinor, postedMinor].forEach(money);
    return this.store.change((s, now) => {
      const o = item(s.studio.orders, reference, 'order');
      requireValue(
        currency === o.currency && refundMinor <= o.paidMinor,
        'Invalid settlement observation'
      );
      const expectedMinor = o.paidMinor - refundMinor - feeMinor;
      o.settlement = {
        time: now,
        feeMinor,
        refundMinor,
        postedMinor,
        expectedMinor,
        differenceMinor: expectedMinor - postedMinor
      };
      return o.settlement;
    });
  }

  status() {
    const s = this.store.read(),
      c = s.studio;
    requireValue(c, 'Incomplete initialization');
    return {
      brand: c.brand,
      products: Object.values(c.products).map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        priceMinor: p.priceMinor
      })),
      posts: Object.values(c.posts),
      inbox: Object.values(c.messages),
      outbox: c.outbox,
      orders: c.orders,
      ...this.engine.inspect(c.owner)
    };
  }

  async work(write = writeDraft) {
    this.tick();
    const c = this.store.read().studio;
    const worker = {
      node: c.node,
      token: fs.readFileSync(path.join(this.dir, 'worker.key'), 'utf8')
    };
    this.engine.heartbeat(worker, true);
    this.engine.probe(c.owner, c.node, {
      name: 'studio',
      state: 'supported',
      version: '1',
      evidence: 'Local worker protocol v1 ready'
    });
    const claim = this.engine.claim(worker, c.run);
    if (!claim) return { status: 'idle' };
    const session = { ...worker, fence: claim.fence };
    const current = this.store.read().studio,
      job = current.jobs[claim.task];
    const control = new AbortController();
    const remaining = Math.min(stepLimit, job.deadline - this.store.clock());
    const deadline = setTimeout(() => control.abort(), Math.max(1, remaining));
    const pulse = setInterval(() => {
      try {
        this.engine.heartbeat(worker, true);
        this.engine.renew(claim.task, session);
      } catch {
        control.abort();
      }
    }, 10000);
    try {
      requireValue(remaining > 0, 'One-hour job deadline reached');
      let input = job.input;
      if (job.kind === 'campaign') {
        const product = item(current.products, input.product, 'product');
        requireValue(product.status === 'available', 'Product retired');
        input = {
          brand: current.brand,
          product: {
            title: product.title,
            summary: product.draft.content.slice(0, 2000)
          },
          chapterNumber: current.chapter + 1,
          prior: current.lastChapter ?? null
        };
      }
      if (job.kind === 'reply') {
        const m = item(current.messages, input.key, 'message'),
          p = item(current.products, m.product, 'product');
        input = {
          brand: current.brand.name,
          question: m.body,
          faq: p.faq,
          product: p.title
        };
      }
      const answer = validateDraft(
        job.kind,
        await write(job.model, job.kind, input, control.signal)
      );
      requireValue(
        !control.signal.aborted && this.store.clock() < job.deadline,
        'Writer deadline reached'
      );
      this.engine.complete(claim.task, session, (s, now, task, attempt) => {
        const c = s.studio;
        if (job.kind === 'brand')
          c.brand = { ...answer, mark: brandMark(answer.name, answer.story) };
        if (job.kind === 'product') {
          const p = c.products[job.input.id];
          p.draft = answer;
          p.status = 'review';
        }
        if (job.kind === 'campaign') {
          const product = job.input.product;
          requireValue(
            c.products[product].status === 'available',
            'Product retired'
          );
          c.chapter++;
          c.lastChapter = answer.chapter;
          for (const [kind, body] of [
            ['story', answer.chapter],
            ['ad', answer.ad]
          ]) {
            const id = randomUUID();
            c.posts[id] = {
              id,
              kind,
              product,
              chapter: c.chapter,
              body,
              callToAction: answer.callToAction,
              time: now,
              transport: 'local',
              spendMinor: 0
            };
          }
        }
        if (job.kind === 'reply') {
          const m = c.messages[job.input.key];
          // Only a reviewed FAQ can authorize a local automatic reply.
          const faq = c.products[m.product].faq;
          if (
            answer.disposition === 'reply' &&
            faq &&
            m.body.trim().toLowerCase() === faq.question.trim().toLowerCase()
          )
            this.sendReply(c, m, faq.answer, now, 'agent');
          else {
            m.status = 'needs-owner';
            m.draft = answer.body;
          }
        }
        if (job.kind === 'ops')
          appendText(c, {
            sender: 'operations-agent',
            topic: 'reply',
            task: claim.task,
            text: answer.body.slice(0, 1500)
          });
        appendText(c, {
          sender: job.kind + '-worker',
          topic: 'result',
          task: claim.task,
          text: 'Completed ' + job.kind + ' work.'
        });
        const artifact = insert(
          s,
          'artifact',
          c.owner,
          { attempt: attempt.id, outputRef: 'studio:' + claim.task },
          now
        );
        c.jobs[claim.task].answer = answer;
        task.checkpoint = artifact.id;
      });
      return {
        status: 'done',
        task: claim.task,
        kind: job.kind,
        model: job.model
      };
    } catch (error) {
      let reason = error.message;
      try {
        this.engine.fail(claim.task, session, reason);
      } catch {
        reason += '; lease expired';
      }
      this.store.change((s) =>
        appendText(s.studio, {
          sender: 'supervisor',
          task: claim.task,
          topic: 'incident',
          text: 'Worker stopped. Inspect the local job for details.'
        })
      );
      return { status: 'stopped', task: claim.task, reason };
    } finally {
      clearInterval(pulse);
      clearTimeout(deadline);
    }
  }
  close() {
    this.store.close();
  }
}
