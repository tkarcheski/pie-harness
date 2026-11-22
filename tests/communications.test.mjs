import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Studio } from '../apps/studio/channel.mjs';
import {
  appendText,
  incomingText,
  transcript
} from '../packages/local/text-bus.mjs';
import {
  DiscordAgentTeam,
  DiscordTransport,
  connectDiscord,
  syncDiscord,
  reconcileDiscord
} from '../packages/local/discord.mjs';

const guild = '100000000000000001',
  channel = '100000000000000002',
  bot = '100000000000000003',
  operator = '100000000000000004';
async function session(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-comms-'));
  const studio = new Studio(dir, { initialize: true });
  t.after(() => {
    studio.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  studio.init({ topic: 'Test', audience: 'readers' });
  await studio.work();
  const service = {
    guild,
    channel,
    operators: new Set([operator]),
    messages: [],
    sent: [],
    async verify() {
      return { guild, channel, bot, latest: '100000000000000010' };
    },
    async receive() {
      return { data: this.messages, nextAt: 0 };
    },
    async send(m) {
      this.sent.push(m);
      return {
        data: { id: '100000000000000020', channel_id: channel },
        nextAt: 0
      };
    }
  };
  await connectDiscord(studio, service);
  return { studio, service };
}

test('local dispatch and Discord cursor isolate history and deduplicate commands', async (t) => {
  const { studio, service } = await session(t);
  await syncDiscord(studio, service);
  assert.equal(service.sent.length, 0);
  service.messages = [
    {
      id: '100000000000000011',
      channel_id: channel,
      author: { id: operator },
      content: '!pie status'
    }
  ];
  await syncDiscord(studio, service);
  await syncDiscord(studio, service);
  assert.equal(service.sent.length, 1);
  assert.match(service.sent[0].text, /Queue/);
  assert.equal(
    transcript(studio).filter((m) => m.externalId === service.messages[0].id)
      .length,
    1
  );
  service.messages = [
    {
      id: '100000000000000012',
      channel_id: channel,
      author: { id: 'unlisted' },
      content: '!pie ask change settings'
    }
  ];
  await syncDiscord(studio, service);
  assert.equal((await studio.work()).status, 'idle');
  service.messages = [
    {
      id: '100000000000000013',
      channel_id: channel,
      author: { id: operator },
      content: '!pie ask What needs review?'
    }
  ];
  await syncDiscord(studio, service);
  assert.equal((await studio.work()).kind, 'ops');
  assert.ok(
    transcript(studio).some(
      (m) => m.sender === 'operations-agent' && m.topic === 'reply'
    )
  );
});

test('three Discord applications share one inbox, route by sender and recover specialist sends', async (t) => {
  const { studio, service } = await session(t);
  const product = '100000000000000005',
    support = '100000000000000006';
  const identities = { op: bot, prod: product, help: support };
  const sends = [];
  let ambiguous = false;
  let messages = [];
  const options = {
    guild,
    channel,
    token: 'op',
    operators: [operator],
    request: async (url, init) => {
      const who = identities[init.headers.Authorization.slice(4)];
      const route = new URL(url).pathname;
      if (route.endsWith('/users/@me'))
        return Response.json({ id: who, bot: true });
      if (route.endsWith('/guilds/' + guild))
        return Response.json({ id: guild });
      if (route.endsWith('/channels/' + channel))
        return Response.json({
          id: channel,
          guild_id: guild,
          type: 0,
          last_message_id: '100000000000000010',
          permission_overwrites: [{ id: guild, type: 0, deny: '1024' }]
        });
      assert.ok(route.endsWith('/messages'));
      if (init.method === 'GET') {
        assert.equal(who, bot, 'Only the coordinator consumes commands');
        return Response.json(messages);
      }
      const { content } = JSON.parse(init.body);
      sends.push({ who, content });
      if (ambiguous) throw new Error('lost receipt');
      return Response.json({ id: '100000000000000022', channel_id: channel });
    }
  };
  const tokens = { product: 'prod', support: 'help' };
  const team = new DiscordAgentTeam(options, tokens, {
    operations: bot,
    product,
    support
  });
  const say = (sender) =>
    studio.store.change((s) =>
      appendText(s.studio, { sender, text: 'test update' })
    );
  say('coordinator');
  say('brand-worker');
  say('product-worker');
  say('campaign-worker');
  const reply = say('reply-worker');
  await connectDiscord(studio, team); // upgrade a single-bot binding, preserve unread work
  for (let n = 0; n < 4; n++) await syncDiscord(studio, team);
  ambiguous = true;
  await assert.rejects(syncDiscord(studio, team), /interrupted/);
  assert.deepEqual(
    sends.map((x) => x.who),
    [bot, product, product, product, support]
  );
  const receipt = {
    id: '100000000000000030',
    author: { id: product, bot: true },
    channel_id: channel,
    content: '[reply-worker] test update\n[pie:' + reply.id + ']'
  };
  messages = [receipt];
  await syncDiscord(studio, team);
  assert.equal(studio.store.read().studio.discord.intent.bot, support);
  const human = {
    id: '100000000000000032',
    channel_id: channel,
    author: { id: operator },
    content: '!pie status'
  };
  messages = [
    {
      ...receipt,
      id: '100000000000000031',
      author: { id: support, bot: true }
    },
    human
  ];
  ambiguous = false;
  await syncDiscord(studio, team);
  await syncDiscord(studio, team);
  assert.equal(studio.store.read().studio.discord.intent, null);
  assert.equal(sends.length, 6);
  assert.equal(sends.at(-1).who, bot);
  assert.equal(
    transcript(studio).filter((m) => m.externalId === human.id).length,
    1
  );
  await assert.rejects(syncDiscord(studio, service), /all configured agents/);
  await assert.rejects(connectDiscord(studio, service), /identity changed/);
  await assert.rejects(
    new DiscordAgentTeam(options, { ...tokens, support: 'prod' }).verify(),
    /distinct bot/
  );
  await assert.rejects(
    new DiscordAgentTeam(options, tokens, { product: support }).verify(),
    /different product/
  );
});

test('ambiguous delivery is held until the original bot receipt is observed', async (t) => {
  const { studio, service } = await session(t);
  const m = studio.store.change((s) =>
    appendText(s.studio, { sender: 'editor', text: 'Review ready' })
  );
  let calls = 0;
  service.send = async () => {
    calls++;
    throw Error('Ambiguous connection failure');
  };
  await assert.rejects(syncDiscord(studio, service), /Ambiguous/);
  await syncDiscord(studio, service);
  assert.equal(calls, 1);
  assert.throws(
    () => reconcileDiscord(studio, { id: 'wrong', outcome: 'observed' }),
    /Invalid/
  );
  service.messages = [
    {
      id: '100000000000000017',
      channel_id: channel,
      author: { id: bot, bot: true },
      content: '[editor] Review ready\n[pie:' + m.id + ']'
    }
  ];
  await syncDiscord(studio, service);
  assert.equal(studio.store.read().studio.discord.intent, null);
  assert.equal(calls, 1);
});

test('Discord verifies guild privacy, local routing, rate limits and text-only payload', async () => {
  const payloads = [];
  let allowEveryone = false,
    limited = false;
  const bridge = new DiscordTransport({
    guild,
    channel,
    token: 'test',
    request: async (url, options) => {
      assert.match(url, /^https:\/\/discord\.com\/api\/v10\//);
      if (url.endsWith('/users/@me'))
        return Response.json({ id: bot, bot: true });
      if (url.endsWith('/guilds/' + guild))
        return Response.json({ id: guild, features: [] });
      if (url.endsWith('/channels/' + channel))
        return Response.json({
          id: channel,
          guild_id: guild,
          type: 0,
          permission_overwrites: [
            { id: guild, type: 0, deny: allowEveryone ? '0' : '1024' }
          ]
        });
      if (limited) return Response.json({ retry_after: 3 }, { status: 429 });
      payloads.push(JSON.parse(options.body));
      return Response.json({ id: bot, channel_id: channel });
    }
  });
  await bridge.verify();
  allowEveryone = true;
  await assert.rejects(bridge.verify(), /Deny View Channel/);
  await bridge.send({
    id: 'sample',
    sender: 'reviewer',
    text: '@everyone test'
  });
  assert.equal(payloads[0].tts, false);
  assert.deepEqual(payloads[0].allowed_mentions, { parse: [] });
  assert.equal(payloads[0].enforce_nonce, true);
  limited = true;
  await assert.rejects(
    bridge.receive('0'),
    (e) => e.retryAt > Date.now() + 1500
  );
});
