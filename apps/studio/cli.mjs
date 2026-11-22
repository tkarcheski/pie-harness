import { incomingText, transcript } from '../../packages/local/text-bus.mjs';
import {
  DiscordAgentTeam,
  connectDiscord,
  syncDiscord,
  reconcileDiscord
} from '../../packages/local/discord.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { health, maintain } from './maintenance.mjs';
import { setTimeout as wait } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Studio } from './channel.mjs';

const help = `PIE digital-product studio
  node apps/studio/cli.mjs STATE_DIRECTORY COMMAND [input.json|-]

  demo       Run an isolated, complete synthetic lifecycle in a fresh directory.
  init       Set brand topic, audience and model (fixture or a local Ollama tag).
  product    Queue a draft from owned source material and a price in USD cents.
  work       Execute one queued task. serve polls until interrupted.
  inspect    Show a complete product draft for owner review.
  review     Approve, revise or retire a product.
  campaign   Queue the next story chapter and local advertisement.
  schedule   Set per-product campaign interval in minutes (0 disables).
  receive    Ingest a local email or social comment using a unique event ID.
  resolve    Send an owner-reviewed reply to an escalated local message.
  order      Record a payment observation for an approved product.
  deliver    Materialize the purchased Markdown edition and local mail envelope.
  settle     Compare paid amount less fees/refunds with a payout observation.
  status     Show queue, nodes, catalog, feed, inbox, outbox and orders.
  export     Write brand artwork, feed and RFC 5322 messages to the state directory.
  health     Check storage, VM resources, node health, and interventions.
  maintain   Create and verify a consistent rolling database snapshot.
  say / messages   Send local operations text, or read the last 100 messages.
  discord-check / discord-connect / discord-sync / discord-serve   Verify, bind, or bridge a private guild text channel.
  discord-status / discord-reconcile   Inspect an uncertain send or record its observed outcome.

Use "-" to read a JSON object from stdin. No live platform or mail transport is configured.`;
const [dir, command, inputFile, ...extra] = process.argv.slice(2);
function writeFileAtomically(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, value, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function exportChannel(studio) {
  const c = studio.status(),
    base = path.join(studio.dir, 'channel-export');
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  if (c.brand) {
    writeFileAtomically(path.join(base, 'brand.svg'), c.brand.mark);
    writeFileAtomically(
      path.join(base, 'brand.json'),
      JSON.stringify(c.brand, null, 2)
    );
  }
  writeFileAtomically(
    path.join(base, 'feed.json'),
    JSON.stringify(c.posts, null, 2)
  );
  const mailbox = path.join(base, 'mail');
  fs.mkdirSync(mailbox, { recursive: true, mode: 0o700 });
  function mail(name, from, to, subject, body) {
    const safe = (value) =>
      String(value)
        .replace(/[\r\n\x00-\x1f]/g, ' ')
        .slice(0, 180);
    const message = [
      'From: ' + safe(from),
      'To: ' + safe(to),
      'Subject: ' + safe(subject),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body)
        .toString('base64')
        .match(/.{1,76}/g)
        ?.join('\r\n') || '',
      ''
    ].join('\r\n');
    writeFileAtomically(path.join(mailbox, name + '.eml'), message);
  }
  for (const m of c.inbox.filter((m) => m.source === 'email'))
    mail('in-' + m.task, m.from, 'support@studio.invalid', 'Support', m.body);
  for (const m of c.outbox.filter((m) => m.transport === 'email'))
    mail(
      'out-' + m.id,
      'support@studio.invalid',
      m.to,
      'Studio response',
      m.body + (m.attachment ? '\nLocal delivery file: ' + m.attachment : '')
    );
  return { directory: base, posts: c.posts.length, messages: c.outbox.length };
}

async function demo(studio) {
  if (studio.store.read().studio)
    throw Error('Demo requires a new state directory');
  studio.init({
    topic: 'Field Notes',
    audience: 'weekend hikers',
    model: 'fixture'
  });
  async function run() {
    const result = await studio.work();
    if (result.status !== 'done') throw Error(JSON.stringify(result));
  }
  await run();
  const faq = {
    question: 'How do I open the guide?',
    answer: 'Open the Markdown file in a text editor.'
  };
  const { product } = studio.product({
    title: 'Trail Notebook',
    source:
      'Record the date, weather, and trail surface. Reflect on a single observation after returning.',
    rightsConfirmed: true,
    priceMinor: 500,
    faq
  });
  await run();
  studio.review({ product, decision: 'approve' });
  await run();
  const post = studio.status().posts.find((p) => p.kind === 'story').id;
  studio.receive({
    source: 'comment',
    eventId: 'sample-comment',
    post,
    from: 'hiker-alias',
    body: faq.question
  });
  await run();
  studio.receive({
    source: 'email',
    eventId: 'sample-email',
    product,
    from: 'reader@studio.invalid',
    body: 'Can I get a custom edition?'
  });
  await run();
  studio.resolve({
    message: 'email:sample-email',
    response: 'We have recorded your custom-edition request.'
  });
  studio.order({
    reference: 'sample-order',
    product,
    buyer: 'reader@studio.invalid',
    paidMinor: 500,
    currency: 'USD'
  });
  const delivery = studio.deliver({ reference: 'sample-order' });
  const settlement = studio.settle({
    reference: 'sample-order',
    feeMinor: 20,
    refundMinor: 0,
    postedMinor: 480,
    currency: 'USD'
  });
  return {
    mode: 'synthetic fixture',
    product,
    delivery,
    settlement,
    channel: exportChannel(studio)
  };
}

let studio;
try {
  if (!dir || dir === '--help' || command === '--help') {
    console.log(help);
  } else {
    if (!command || extra.length)
      throw Error('Expected state directory, command and optional JSON input');
    const input = inputFile
      ? JSON.parse(
          fs
            .readFileSync(inputFile === '-' ? 0 : inputFile, 'utf8')
            .replace(/^\uFEFF/, '')
        )
      : {};
    studio = new Studio(dir, {
      initialize: ['init', 'demo'].includes(command)
    });
    let result;
    if (command === 'demo') result = await demo(studio);
    else if (command === 'say')
      result = studio.store.change((s, now) =>
        incomingText(
          s,
          { sender: input.sender || 'owner', text: input.text },
          { canAsk: true, time: now }
        )
      );
    else if (command === 'messages') result = transcript(studio, input.after);
    else if (command === 'discord-status')
      result = studio.store.read().studio.discord || { connected: false };
    else if (command === 'discord-reconcile')
      result = reconcileDiscord(studio, input);
    else if (
      [
        'discord-check',
        'discord-connect',
        'discord-sync',
        'discord-serve'
      ].includes(command)
    ) {
      const bridge = new DiscordAgentTeam(
        {
          token: process.env.PIE_DISCORD_BOT_TOKEN,
          guild: process.env.PIE_DISCORD_GUILD_ID,
          channel: process.env.PIE_DISCORD_CHANNEL_ID,
          operators: (process.env.PIE_DISCORD_OPERATOR_IDS || '')
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        },
        {
          product: process.env.PIE_DISCORD_PRODUCT_TOKEN,
          support: process.env.PIE_DISCORD_SUPPORT_TOKEN
        },
        {
          operations: process.env.PIE_DISCORD_OPERATIONS_APP_ID,
          product: process.env.PIE_DISCORD_PRODUCT_APP_ID,
          support: process.env.PIE_DISCORD_SUPPORT_APP_ID
        }
      );
      if (command === 'discord-check') result = await bridge.verify();
      if (command === 'discord-connect')
        result = await connectDiscord(studio, bridge);
      if (command === 'discord-sync')
        result = await syncDiscord(studio, bridge);
      if (command === 'discord-serve') {
        const stop = new AbortController();
        process.on('SIGINT', () => stop.abort());
        process.on('SIGTERM', () => stop.abort());
        while (!stop.signal.aborted) {
          const tick = await syncDiscord(studio, bridge);
          console.log(JSON.stringify(tick));
          await wait(Math.max(15000, (tick.until || 0) - Date.now()), null, {
            signal: stop.signal
          }).catch(() => {});
        }
        result = { status: 'bridge stopped' };
      }
    } else if (command === 'work') result = await studio.work();
    else if (command === 'serve') {
      const stop = new AbortController();
      const requestStop = () => stop.abort();
      process.on('SIGINT', requestStop);
      process.on('SIGTERM', requestStop);
      while (!stop.signal.aborted) {
        const last = studio.store.read().studio.lastBackup?.at ?? 0;
        if (Date.now() - last >= 86400000) maintain(studio);
        const job = await studio.work();
        if (job.status !== 'idle') console.log(JSON.stringify(job));
        if (job.status !== 'done')
          await wait(2000, null, { signal: stop.signal }).catch(() => {});
      }
      result = { status: 'worker stopped' };
    } else if (command === 'export') result = exportChannel(studio);
    else if (command === 'inspect') {
      const p = studio.store.read().studio.products;
      if (!Object.hasOwn(p, input.product)) throw Error('Unknown product');
      result = p[input.product];
    } else if (command === 'health') {
      result = health(studio);
      if (
        result.integrity !== 'ok' ||
        result.failed ||
        result.nodes.some((n) => n.state === 'offline')
      )
        process.exitCode = 1;
    } else if (command === 'maintain') result = maintain(studio);
    else if (
      [
        'init',
        'product',
        'review',
        'campaign',
        'schedule',
        'receive',
        'resolve',
        'order',
        'deliver',
        'settle',
        'status'
      ].includes(command)
    ) {
      result = studio[command](input);
    } else throw Error('Unknown studio command');
    if (result?.status === 'stopped') process.exitCode = 1;
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
} finally {
  studio?.close();
}
