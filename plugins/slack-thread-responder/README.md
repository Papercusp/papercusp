# Slack thread responder trigger pack

This first-party starter packages one Slack mention trigger and one reusable plan target. The
target replies only through the provider-neutral `chat:reply`, whose server resolves the source, channel,
thread, and credential from the durable trigger run. The workflow can shape response tone, but it
cannot redirect the reply.

The trigger binds `ext:slack:mention` from a `slack` data source, which the `slack` provider
package creates when you connect Slack on Settings → Integrations. The pack holds no Slack
credential: the app and bot tokens stay with that package's source, so they never enter the pack
or a snapshot. The manifest declares the canonical `chat-message` input and a bounded storm
policy. Cupboard installation only discovers the pack; connecting Slack, instantiating and arming
remain explicit.
