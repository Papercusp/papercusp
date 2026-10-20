# Discord provider

Installs as a sandboxed daemon using the shared provider SDK. Settings → Integrations shows the declared bot-token field; the token stays in the host's protected credential store. The host sends it as `Authorization: Bot <token>`, and only to `discord.com`.

Source settings: `channelId` (where notifications go), `guildId` (your server, used by the community badge and for message links) and an optional `inviteUrl` (`https://discord.gg/<code>` or `https://discord.com/invite/<code>` only).

`notify.send` accepts `{text, idempotencyKey}`. Text is at most 2,000 characters, Discord's limit. Mentions never ping: the package sends `allowed_mentions: {parse: []}`, so `@everyone`, roles and users stay plain text. The idempotency key becomes a Discord nonce sent with `enforce_nonce`, so a repeat within Discord's few-minute window returns the first message instead of posting twice. Embeds are not offered. One request returns `{externalId, channelId, url?}`. Transport failures, server errors and malformed successes remain ambiguous; callers must reconcile before sending again. The package never retries or owns backoff policy.

`community.presence` reads the server's public widget (`/guilds/{guildId}/widget.json`) and returns `{guildId, widget, presenceCount, name, inviteUrl}`. A server with its widget turned off returns `widget: "disabled"` and a null count, not an error. Turn it on in Discord under Server Settings → Widget.

Agents call `notify:send` with `providerId:"discord"`, the connected `sourceId`, the text and trusted `addressee` provenance. The host checks personal access and disclosure before anything leaves the box.

## Community bot (reading and answering members)

The package declares a Gateway connection as data (`ingress.socket.session`), and the host runs it: it asks `GET /api/v10/gateway/bot` for a socket URL with the bot token, connects with `v=10&encoding=json`, answers the hello with an identify frame (the host fills in the token; this package never sees it), and sends heartbeats carrying the latest sequence number. Only dispatch frames reach the package.

The identify frame asks for the GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES and MESSAGE_CONTENT intents. **Message Content is a privileged intent: turn it on under Developer Portal → your application → Bot → Privileged Gateway Intents**, or Discord closes the connection (code 4014) and the source shows `socket_closed:4014`.

`ingress.normalize` turns each `MESSAGE_CREATE` a person wrote into a `chat-message` record: `nativeId` `<channel>:<message>`, `event` `message`, `mention` (the message @mentions the bot; needs the optional `botUserId` setting) or `dm` (a direct message), and a payload of `{id, channelId, threadId, threadKey, sender, text, mentions, extensions.discord}`. `threadId` is the message's own id, so replying to it answers that message; `threadKey` is the message it replied to, if any. Bot and webhook posts (this bot's own replies included), system messages, empty messages and, with `guildId` set, other servers' messages are dropped. Records go to the document store and the event stream by default, so a workflow can answer members' questions.

`chat.reply` posts `text` (up to 2,000 characters) as a Discord reply to `threadId` in `channelId` and returns `{channelId, threadId, messageTs}`, where `messageTs` is the new message's id. It never pings anyone, including the person replied to. The same reply to the same message reuses its nonce, so a repeat inside Discord's window returns the first message.

Limits: there is no session resume. When Discord asks for a reconnect or invalidates the session, the host opens a fresh connection and identifies again, so messages sent during that gap are not read. Heartbeats run on the host's 15-second ingress tick, so each beat is sent before Discord's interval (about 41 seconds) runs out; the host does not watch for missing heartbeat acknowledgements.

Contract checked 2026-10-20 against Discord's primary API documentation ([messages](https://raw.githubusercontent.com/discord/discord-api-docs/main/developers/resources/message.mdx), [guild widget](https://raw.githubusercontent.com/discord/discord-api-docs/main/developers/resources/guild.mdx), [rate limits](https://raw.githubusercontent.com/discord/discord-api-docs/main/developers/topics/rate-limits.mdx), [Gateway](https://raw.githubusercontent.com/discord/discord-api-docs/main/developers/events/gateway.mdx), [Gateway events](https://raw.githubusercontent.com/discord/discord-api-docs/main/developers/events/gateway-events.mdx)). Verified with recorded fakes, a fake gateway in the host's socket-ingress tests, the shared conformance kit and package tests. **Not live-verified**; no message was sent to or read from Discord during implementation. Live verification needs a bot token with Message Content turned on.
