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
