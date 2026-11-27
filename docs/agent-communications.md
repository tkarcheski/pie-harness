# Agent text communications

The local operations transcript keeps assignments, completions, incidents and handoffs across restarts. Each entry has a sender, room, message ID, topic and time. It can also reference a task or an external message. Agents read from a cursor and post text to the room. This distribution's bridge sends ordinary text with Discord TTS disabled.

## Simulate without Discord

Open PowerShell in the directory that contains `apps/studio`.

```powershell
$studio = Join-Path $env:LOCALAPPDATA 'PIE-Comms-Practice'
node apps/studio/cli.mjs $studio demo
'{"sender":"owner","text":"!pie status"}' | node apps/studio/cli.mjs $studio say -
'{"sender":"reviewer","text":"!pie ask Which jobs need attention?"}' | node apps/studio/cli.mjs $studio say -
node apps/studio/cli.mjs $studio work
node apps/studio/cli.mjs $studio messages
```

Run `demo` in a fresh directory. For an initialized Studio, start with `say`. The assistant uses queue counts and the number of owner reviews to answer a status question. Each sender can have one pending question. Normal posts enter the transcript. An operations question grants no authority over orders, approvals, spending, accounts or host settings.

## Set up the private Discord room

1. Create a server with **Add a Server → Create My Own**, or select one you administer. Keep membership invite-only. Create a private text channel such as **#agent-operations**.
2. In channel permissions, deny **View Channel** to `@everyone`. Allow the operator role and the bot to view the channel. Inspect other member and role overrides. The bridge checks the server ID, text room type, discovery setting and explicit deny.
3. Create a Discord application and use its bot user. In **Bot**, enable **Message Content Intent** for ordinary operations text. Keep the bot token in your secret manager. [Discord Developer Portal](https://discord.com/developers/applications)
4. Under **Guild Install**, select the **bot** scope. Grant **View Channel**, **Send Messages** and **Read Message History**. Open the install link to add the bot to your server. Give it explicit access to the private room. The bridge runs without administrator, management or voice permissions.
5. In Discord **Advanced** settings, enable **Developer Mode**. Copy the server ID, channel ID and your user ID. From the distribution root, start the helper with the initialized Studio directory.

```powershell
.\apps\studio\setup-discord.ps1 -StateDirectory $studio -StartBridge
```

The Windows helper asks for the IDs and the token through a hidden prompt. It verifies the account and room before binding. It restores the calling shell's environment on exit. On restart, run the helper again or inject the token from your vault. When this distribution is staged inside a larger checkout, run the command from this distribution's root.

6. In a second terminal, run `node apps/studio/cli.mjs $studio serve`. Send `!pie status` to the private room. Check the returned counts.
7. From an authorized operator ID, send `!pie ask <question>`. The worker queues the question and posts its answer. Other members with room access can post notes. The bridge ignores commands from bots. Daily brand, product, campaign and support jobs post their updates automatically.

### Separate Discord applications

Install Operations, Product and Support in the same private text room for a three-app rehearsal. Give each bot View Channel, Send Messages and Read Message History. Operations needs Message Content Intent for commands. Product and Support can send updates with default intents.

Start one bridge. On Windows, run `setup-discord.ps1 -StateDirectory $studio -AgentTeam -StartBridge`. Enter each token at its local prompt. On another platform, supply the coordinator token and set `PIE_DISCORD_PRODUCT_TOKEN` and `PIE_DISCORD_SUPPORT_TOKEN`. To verify each registered app, set `PIE_DISCORD_OPERATIONS_APP_ID`, `PIE_DISCORD_PRODUCT_APP_ID` and `PIE_DISCORD_SUPPORT_APP_ID` to its application ID.

| Discord application | Messages it sends |
| --- | --- |
| Operations | Assignments, handoffs, status, incidents, operator notes and operations answers |
| Product | Brand, product and campaign worker updates |
| Support | Customer reply worker updates |

The three identities share one transcript cursor. The original sending bot or the operator must confirm a pending delivery. To add specialists, stop the existing bridge. Run the helper again with the same coordinator and room. The bridge keeps its progress. After you bind a specialist, supply that same identity on restart.

## Transport and recovery

The local Studio and its social ad feed can run independently of Discord. The bridge reads and sends messages through Discord API v10 over HTTPS. It mirrors the configured operations channel. It excludes direct messages, other rooms, attachments, historical exports and automatic mentions.

On systems without the Windows helper, set `PIE_DISCORD_GUILD_ID`, `PIE_DISCORD_CHANNEL_ID` and `PIE_DISCORD_BOT_TOKEN` for the bridge process. For operator commands, set the optional comma-separated `PIE_DISCORD_OPERATOR_IDS`. Run `discord-check`, `discord-connect` and `discord-serve` in that order. Keep tokens outside Git and the state database.

### Check an uncertain delivery

Binding starts at the current end of each transcript. The bridge saves the remote cursor to deduplicate incoming messages. For each send, it saves the intent, nonce and visible message ID. On a rate limit, it waits for Discord's retry time.

1. If Discord may have accepted a send, check for the matching bot-authored receipt.
2. Run `discord-status` to get the pending ID. Inspect the actual Discord room.
3. Run `discord-reconcile` with that ID and `observed` or `confirmed-absent`. Only a verified absence releases the message for retry.

[Discord bot installation](https://discord.com/developers/docs/quick-start/getting-started) · [Channel permissions](https://docs.discord.com/developers/topics/permissions) · [Message API](https://docs.discord.com/developers/resources/message) · [Rate limits](https://docs.discord.com/developers/topics/rate-limits)
