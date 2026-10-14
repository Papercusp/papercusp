# `slack` provider package

Connects one Slack workspace to Papercusp. Install it from the Cupboard, then connect it on
Settings → Integrations. Every message the Papercusp Slack app sees becomes a `chat-message`
record that installed workflows (trigger packs) can react to, and workflows can reply in the
thread. An organization-wide source also brings in the history of every channel the app is in,
and live search reads Slack directly for the person searching.

## Connecting it

1. On the Slack card, choose **Create app**. It opens `api.slack.com/apps` with this package's
   app manifest filled in (or copy the manifest and use *Create New App → From a manifest*).
2. Install the app to your workspace.
3. Paste the two tokens on the card:
   - **App-level token** (`xapp-…`): *Basic Information → App-Level Tokens*, with the
     `connections:write` scope. Papercusp uses it only to open the Socket Mode connection.
   - **Bot token** (`xoxb-…`): *OAuth & Permissions → Bot User OAuth Token*. Papercusp sends it
     only to `slack.com`.
4. Optional, on the same card: make the source **organization-wide**, and switch on **live
   search**. Each person who searches then pastes their own **user token** (`xoxp-…`, *OAuth &
   Permissions → User OAuth Token*, shown to whoever installed the app). It is theirs alone:
   Papercusp sends it to `slack.com` only for that person's searches.

Tokens are stored by the Papercusp host. They are never shown again, and this package never
reads them: the host attaches them to the requests the package makes.

## What it declares

- **Credentials** (`setup.credentials`): `app_token` and `bot_token` for the source, and the
  per-person `user_token` (`perPrincipal`), each checked against its pattern when you save it.
- **App definition** (`setup.appRegistration`): a Socket Mode Slack app with the bot scopes
  `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`,
  `channels:read`, `groups:read`, `commands`, `chat:write` and `reactions:read`; the user scopes
  `search:read.public`, `search:read.private`, `search:read.mpim` and `search:read.im`; the
  `app_mention`, `message.*` and `reaction_added` events; the `/papercusp` slash command; the
  "Report a bug" message shortcut; and interactivity.
- **Socket ingress** (`ingress.socket`): the host calls `apps.connections.open` with the app
  token, holds the WebSocket, acknowledges each envelope by `envelope_id`, and reconnects when
  Slack sends `disconnect`. Interactive envelopes are handled at once so the report form opens
  inside Slack's three-second window. The package never holds the socket.
- **`ingress.normalize`**: turns an envelope into `chat-message` records: channel posts
  (`message`), mentions, direct messages (`dm`), slash commands, a reaction on a message
  (`reaction`), and a message reported through the "Report a bug" shortcut's form (`report`).
  An edit of a recorded message is an `edited` record of the same message (it keeps its post
  time and carries `editedAt`); a deletion, or the tombstone Slack leaves for a deleted thread
  root, is a `deleted` record with no text, and the host erases the stored message. Bot, app
  and system posts are skipped. Every record names its channel as `aclRef`.
- **Membership** (`membership`, with containers): on an organization source each channel is a
  container whose readers are exactly its current Slack members, so a message is readable only
  by people in its channel. Member ids are Slack user ids (identity provider `slack`).
- **`provider.syncPage`**: a personal source has nothing to crawl. An organization source
  starts each round with a membership page (every channel the app is in, with its members),
  then backfills each newly seen channel one `conversations.history` page at a time, thread
  replies included, as `history` records, so workflows bound to new messages never fire on old
  ones. After that, each pass refreshes membership and the socket brings new messages. A Slack
  rate limit makes the host wait out `Retry-After`.
- **`search.live`**: `{ query, limit }` → `assistant.search.context` with the searching
  person's own user token, so Slack decides what they can see. Nothing is stored.
- **`chat.channels`**: lists the channels the bot can read, for channel pickers in workflow
  settings.
- **`chat.reply`**: `{ channelId, threadId, text }` → `chat.postMessage` in that thread.

## Using it with a workflow

Trigger packs bind to the `chat-message` datatype, not to Slack, so any pack that reads chat
messages works with this package. For example, **Bug triage** files each bug report posted in
the channels you pick as one ticket in the project you pick, and files a message someone reacts
to with :bug: or reports through the shortcut.

## License

MIT.
