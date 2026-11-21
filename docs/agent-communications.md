# Agent text communications

The operations transcript is a durable local text room. Each entry carries a sender, room, message ID, topic, time, and optional task or external message ID. Workers announce assignments, completions, incidents and handoffs. An agent can read the transcript with a cursor and post text without knowing which transport mirrors the room. Voice and TTS are deferred. The bot sends ordinary text with TTS disabled.

## Simulate without Discord

From the standalone root in PowerShell:

```powershell
$studio = Join-Path $env:LOCALAPPDATA 'PIE-Comms-Practice'
node apps/studio/cli.mjs $studio demo
'{"sender":"owner","text":"!pie status"}' | node apps/studio/cli.mjs $studio say -
'{"sender":"reviewer","text":"!pie ask Which jobs need attention?"}' | node apps/studio/cli.mjs $studio say -
node apps/studio/cli.mjs $studio work
node apps/studio/cli.mjs $studio messages
```

Use a fresh directory for demo. For an existing initialized studio, begin at say. A local assistant answers status questions from queue counts and the owner-review count. One question per sender may be pending. Normal messages are conversation data. An operations question cannot alter orders, approvals, spending, accounts or host configuration.

## Set up the private Discord room

1. In Discord, use **Add a Server → Create My Own** (or choose a server you administer). Use a private server such as **PIE Operations** and a text channel such as **#agent-operations**. Keep membership invite-only.
2. In channel permissions, explicitly **deny View Channel to @everyone**. Allow your operator role and the PIE bot to view the channel. Review any other role or member overrides. The bridge checks the server ID, text channel type, discovery setting and the explicit @everyone deny.
3. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Use its bot user. In the **Bot** settings enable **Message Content Intent** so ordinary operations text is available. Keep the token in an owner-controlled secret manager. Use a bot token rather than a personal Discord account token.
4. Configure **Guild Install** with the **bot** scope and **View Channel**, **Send Messages**, **Read Message History**. Use Discord's install link to add it to that server. The bridge needs no Administrator, Manage Roles, Manage Server or voice permissions. Grant the bot access to the private channel explicitly.
5. In Discord's Advanced settings enable **Developer Mode**. Copy the server ID, channel ID and your own user ID. Run the following from the distribution root with the initialized state directory you chose:

```powershell
.\apps\studio\setup-discord.ps1 -StateDirectory $studio -StartBridge
```

The Windows helper prompts locally for the IDs and a hidden token. It verifies the account and channel before binding. It restores the caller's environment when it exits. It does not save the token. On restart rerun the helper or inject the secret from your vault. When running from the canonical checkout, add public/ to the script path.

In a second terminal run `node apps/studio/cli.mjs $studio serve`. Send `!pie status` in the private channel. The bot replies with counts. Authorized operator IDs can also send `!pie ask <question>`; the worker queues the request and responds in text. Other people with channel access can post notes. Bot-authored messages are ignored as inbound commands to avoid loops. One bot displays the logical agent identity in each outbound message. Daily brand, product, campaign and support jobs emit updates automatically.

## Transport and recovery

Discord is an optional adapter. The local studio and its local social advertising feed run without it. The connector uses API v10 HTTPS message history and message creation. It mirrors only the configured operations channel. Direct messages, other channels, attachments, historical exports and automatic mentions are excluded.

For non-Windows operation supply PIE_DISCORD_GUILD_ID, PIE_DISCORD_CHANNEL_ID, optional comma-separated PIE_DISCORD_OPERATOR_IDS, and PIE_DISCORD_BOT_TOKEN through the process environment. Use discord-check, discord-connect, and discord-serve in that order. Keep bot tokens outside Git and outside the state database.

Binding starts at the current end of both transcripts. A durable remote cursor deduplicates ingress. A persisted outgoing intent, nonce and visible message identifier support delivery readback. On rate limiting the bridge honors the retry time. If Discord may have accepted a send, the bridge waits for its matching bot-authored receipt. Use discord-status for a pending ID; after checking the actual channel the owner may run discord-reconcile with that ID and an outcome of observed or confirmed-absent. The latter releases that message for retry. The adapter never retries an ambiguous send blindly.

Official references: [bot installation](https://discord.com/developers/docs/quick-start/getting-started), [channel permissions](https://docs.discord.com/developers/topics/permissions), [message API](https://docs.discord.com/developers/resources/message), and [rate limits](https://docs.discord.com/developers/topics/rate-limits).
