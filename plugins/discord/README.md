# Discord provider

Installs as a sandboxed daemon using the shared provider SDK. Settings → Integrations shows the declared bot-token field; the token stays in the host's protected credential store. The host sends it as `Authorization: Bot <token>`, and only to `discord.com`.

Source settings: `channelId` (where notifications go), `guildId` (your server, used by the community badge and for message links) and an optional `inviteUrl` (`https://discord.gg/<code>` or `https://discord.com/invite/<code>` only).

`notify.send` accepts `{text, idempotencyKey}`. Text is at most 2,000 characters, Discord's limit. Mentions never ping: the package sends `allowed_mentions: {parse: []}`, so `@everyone`, roles and users stay plain text. The idempotency key becomes a Discord nonce sent with `enforce_nonce`, so a repeat within Discord's few-minute window returns the first message instead of posting twice. Embeds are not offered. One request returns `{externalId, channelId, url?}`. Transport failures, server errors and malformed successes remain ambiguous; callers must reconcile before sending again. The package never retries or owns backoff policy.

`community.presence` reads the server's public widget (`/guilds/{guildId}/widget.json`) and returns `{guildId, widget, presenceCount, name, inviteUrl}`. A server with its widget turned off returns `widget: "disabled"` and a null count, not an error. Turn it on in Discord under Server Settings → Widget.

Agents call `notify:send` with `providerId:"discord"`, the connected `sourceId`, the text and trusted `addressee` provenance. The host checks personal access and disclosure before anything leaves the box.

Contract checked 2026-10-20 against Discord's primary API documentation ([messages](https://raw.githubusercontent.com/discord/discord-api-docs/main/developers/resources/message.mdx), [guild widget](https://raw.githubusercontent.com/discord/discord-api-docs/main/developers/resources/guild.mdx), [rate limits](https://raw.githubusercontent.com/discord/discord-api-docs/main/developers/topics/rate-limits.mdx)). Verified with recorded fakes, the shared conformance kit and package tests. **Not live-verified**; no message was sent to Discord during implementation.
