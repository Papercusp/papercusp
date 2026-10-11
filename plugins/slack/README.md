# `slack` provider package

Connects one Slack workspace to Papercusp. Install it from the Cupboard, then connect it on
Settings → Integrations. Every message the Papercusp Slack app sees becomes a `chat-message`
record that installed workflows (trigger packs) can react to, and workflows can reply in the
thread.

## Connecting it

1. On the Slack card, choose **Create app**. It opens `api.slack.com/apps` with this package's
   app manifest filled in (or copy the manifest and use *Create New App → From a manifest*).
2. Install the app to your workspace.
3. Paste the two tokens on the card:
   - **App-level token** (`xapp-…`): *Basic Information → App-Level Tokens*, with the
     `connections:write` scope. Papercusp uses it only to open the Socket Mode connection.
   - **Bot token** (`xoxb-…`): *OAuth & Permissions → Bot User OAuth Token*. Papercusp sends it
     only to `slack.com`.

Tokens are stored by the Papercusp host. They are never shown again, and this package never
reads them: the host attaches them to the requests the package makes.

## What it declares

- **Credentials** (`setup.credentials`): `app_token` and `bot_token`, each checked against its
  pattern when you save it.
- **App definition** (`setup.appRegistration`): a Socket Mode Slack app with the bot scopes
  `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`,
  `channels:read`, `groups:read`, `commands` and `chat:write`; the `app_mention` and
  `message.*` events; and the `/papercusp` slash command.
- **Socket ingress** (`ingress.socket`): the host calls `apps.connections.open` with the app
  token, holds the WebSocket, acknowledges each envelope by `envelope_id`, and reconnects when
  Slack sends `disconnect`. The package never holds the socket.
- **`ingress.normalize`**: turns an envelope into `chat-message` records for channel posts,
  mentions, direct messages and slash commands. Bot, app and edited-message events are
  skipped. A mention and the matching channel post arrive as separate records.
- **`chat.channels`**: lists the channels the bot can read, for channel pickers in workflow
  settings.
- **`chat.reply`**: `{ channelId, threadId, text }` → `chat.postMessage` in that thread.

## Using it with a workflow

Trigger packs bind to the `chat-message` datatype, not to Slack, so any pack that reads chat
messages works with this package. For example, **Bug triage** files each bug report posted in
the channels you pick as one ticket in the project you pick.

Not included: Slack's "Report a bug" message shortcut and reaction gestures. They need
interactive payloads and reaction events this package does not declare yet.

## License

MIT.
