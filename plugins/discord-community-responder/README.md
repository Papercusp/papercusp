# Discord community responder trigger pack

This first-party starter packages one Discord mention trigger and one reusable plan target. When a
member @mentions your bot, the target answers with a Discord reply to that member's message, only
through the provider-neutral `chat:reply`, whose server resolves the source, channel, message and
credential from the durable trigger run. The workflow can shape response tone, but it cannot
redirect the reply.

The trigger binds `ext:discord:mention` from a `discord` data source, which the `discord` provider
package creates when you connect Discord on Settings → Integrations. Set the source's **Bot user ID**
so a mention of the bot is recorded as a `mention` (otherwise it is an ordinary `message` and this
trigger never fires), and turn on the bot's Message Content intent in the Discord Developer Portal.
The pack holds no Discord credential: the bot token stays with that package's source, so it never
enters the pack or a snapshot. The manifest declares the canonical `chat-message` input and a
bounded storm policy. Cupboard installation only discovers the pack; connecting Discord,
instantiating and arming remain explicit.
