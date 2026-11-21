import { requireValue } from './store.mjs';
import { incomingText } from './text-bus.mjs';

const snowflake = (v) => typeof v === 'string' && /^[1-9][0-9]{15,19}$/.test(v);
const now = () => Date.now();
const marker = (id) => '[pie:' + id + ']';
const waitUntil = (duration) => now() + Math.ceil(duration * 1000);
export class DiscordTransport {
  constructor({ token, guild, channel, operators = [], request = fetch }) {
    requireValue(
      typeof token === 'string' &&
        token.trim() &&
        snowflake(guild) &&
        snowflake(channel),
      'Configure the bot secret and valid server and text channel IDs locally'
    );
    requireValue(
      Array.isArray(operators) && operators.every(snowflake),
      'Invalid Discord operator IDs'
    );
    this.operators = new Set(operators);
    this.guild = guild;
    this.channel = channel;
    this.request = async (method, route, data) => {
      let res;
      try {
        res = await request('https://discord.com/api/v10' + route, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: 'Bot ' + token,
            'Content-Type': 'application/json'
          },
          body: data ? JSON.stringify(data) : undefined
        });
      } catch {
        throw Error('Discord transport interrupted');
      }
      if (res.status === 429) {
        const response = await res.json();
        const error = Error('Discord rate limited');
        error.retryAt = waitUntil(
          Math.max(1, Number(response.retry_after) || 1)
        );
        throw error;
      }
      if (!res.ok) throw Error('Discord returned HTTP ' + res.status);
      return {
        data: await res.json(),
        nextAt:
          res.headers.get('x-ratelimit-remaining') === '0'
            ? waitUntil(
                Math.max(
                  1,
                  Number(res.headers.get('x-ratelimit-reset-after')) || 1
                )
              )
            : 0
      };
    };
  }

  async verify() {
    const { data: bot } = await this.request('GET', '/users/@me');
    requireValue(bot.bot === true && snowflake(bot.id), 'Expected bot account');
    const { data: guild } = await this.request('GET', '/guilds/' + this.guild);
    requireValue(
      guild.id === this.guild && !guild.features?.includes('DISCOVERABLE'),
      'Select a private guild'
    );
    const { data: c } = await this.request('GET', '/channels/' + this.channel);
    requireValue(
      c.id === this.channel && c.guild_id === this.guild && c.type === 0,
      'Select a guild text channel in the configured server'
    );
    const everyone = c.permission_overwrites?.find(
      (p) => p.id === this.guild && p.type === 0
    );
    requireValue(
      everyone && (BigInt(everyone.deny) & 1024n) !== 0n,
      'Deny View Channel to @everyone on the operations channel'
    );
    return {
      bot: bot.id,
      guild: guild.id,
      channel: c.id,
      latest: c.last_message_id
    };
  }
  async receive(after) {
    return this.request(
      'GET',
      '/channels/' + this.channel + '/messages?limit=100&after=' + after
    );
  }
  async send(message) {
    return this.request('POST', '/channels/' + this.channel + '/messages', {
      content:
        '[' + message.sender + '] ' + message.text + '\n' + marker(message.id),
      allowed_mentions: { parse: [] },
      flags: 4,
      tts: false,
      nonce: message.id.replaceAll('-', '').slice(0, 24),
      enforce_nonce: true
    });
  }
}

export async function connectDiscord(studio, transport) {
  const verified = await transport.verify();
  return studio.store.change((s) => {
    const c = s.studio,
      old = c.discord;
    if (old) {
      requireValue(
        old.guild === verified.guild &&
          old.channel === verified.channel &&
          old.bot === verified.bot,
        'Existing bridge has a different destination'
      );
      return { guild: old.guild, channel: old.channel, connected: true };
    }
    // Start at activation. No pre-existing local notes or channel history are broadcast.
    c.discord = {
      guild: verified.guild,
      channel: verified.channel,
      bot: verified.bot,
      after: verified.latest || '0',
      index: (c.transcript || []).length,
      until: 0,
      intent: null
    };
    return {
      guild: verified.guild,
      channel: verified.channel,
      connected: true
    };
  });
}

export async function syncDiscord(studio, transport) {
  const binding = studio.store.read().studio.discord;
  requireValue(
    binding &&
      binding.guild === transport.guild &&
      binding.channel === transport.channel,
    'Connect and verify this bridge first'
  );
  if (binding.until > now()) return { status: 'waiting', until: binding.until };
  // A channel can move or its privacy can change after setup. Check on each sync.
  try {
    const verified = await transport.verify();
    requireValue(verified.bot === binding.bot, 'Discord bot identity changed');
    const page = await transport.receive(binding.after);
    const messages = page.data
      .filter((m) => snowflake(m.id))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    studio.store.change((s) => {
      const c = s.studio,
        b = c.discord;
      b.until = Math.max(b.until, page.nextAt || 0);
      for (const m of messages) {
        if (BigInt(m.id) <= BigInt(b.after)) continue;
        requireValue(
          m.channel_id === b.channel && (!m.guild_id || m.guild_id === b.guild),
          'Message scope mismatch'
        );
        if (
          m.author?.id === b.bot &&
          b.intent &&
          m.content?.endsWith(marker(b.intent.id))
        ) {
          b.index++;
          b.intent = null;
        } else if (
          m.author &&
          !m.author.bot &&
          !m.webhook_id &&
          typeof m.content === 'string' &&
          m.content.trim()
        ) {
          incomingText(
            s,
            {
              sender: 'discord:' + m.author.id,
              origin: 'discord',
              externalId: m.id,
              text: m.content.slice(0, 1500)
            },
            {
              canAsk: transport.operators?.has(m.author.id),
              time: studio.store.clock()
            }
          );
        }
        b.after = m.id;
      }
    });
    const candidate = studio.store.change((s) => {
      const c = s.studio,
        b = c.discord,
        rows = c.transcript || [];
      if (b.intent || b.until > now()) return null;
      while (b.index < rows.length && rows[b.index].origin !== 'local')
        b.index++;
      if (b.index >= rows.length) return null;
      const m = rows[b.index];
      b.intent = { id: m.id, since: now() };
      return m;
    });
    if (!candidate)
      return {
        status: 'polled',
        pendingReceipt: !!studio.store.read().studio.discord.intent
      };
    try {
      const result = await transport.send(candidate);
      requireValue(
        snowflake(result.data.id) && result.data.channel_id === binding.channel,
        'Unconfirmed channel receipt'
      );
      studio.store.change((s) => {
        const b = s.studio.discord;
        if (b.intent?.id === candidate.id) {
          b.index++;
          b.intent = null;
        }
        b.until = Math.max(b.until, result.nextAt || 0);
      });
      return { status: 'sent', id: result.data.id };
    } catch (error) {
      if (error.retryAt)
        studio.store.change((s) => {
          if (s.studio.discord.intent?.id === candidate.id)
            s.studio.discord.intent = null;
        });
      throw error;
    }
  } catch (error) {
    if (!error.retryAt) throw error;
    studio.store.change((s) => {
      s.studio.discord.until = Math.max(s.studio.discord.until, error.retryAt);
    });
    return { status: 'waiting', until: error.retryAt };
  }
}

// Trusted operator only: confirm a visible receipt or confirm absence after
// checking the channel. An uncertain send never retries automatically.
export function reconcileDiscord(studio, { id, outcome }) {
  return studio.store.change((s) => {
    const b = s.studio.discord;
    requireValue(
      b?.intent?.id === id &&
        ['observed', 'confirmed-absent'].includes(outcome),
      'Invalid pending receipt or outcome'
    );
    if (outcome === 'observed') b.index++;
    b.intent = null;
    return { id, outcome };
  });
}
