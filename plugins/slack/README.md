# `slack` provider package

A Cupboard-distributed provider package that connects one Slack workspace to Papercusp.
It replaces the in-app Slack integration (plan `cupboard-distributable-integrations-2026-10-10`,
items P-006 and P-008).

## What it declares

- **Credentials** (`setup.credentials`): `app_token` (`xapp-…`, used only to open the Socket
  Mode connection) and `bot_token` (`xoxb-…`, used for Web API calls to `slack.com`). Both are
  pasted on the generic Integrations card and stored by the host. Saving a complete set
  connects the owner's `slack` source (D-006).
- **App definition** (`setup.appRegistration`): a "Create app" link that opens
  `api.slack.com/apps` pre-filled with a Socket Mode manifest: bot scopes, the `app_mention` and
  `message.*` events, and the `/papercusp` slash command.
- **Socket ingress** (`ingress.socket`, D-009): the host opens
  `apps.connections.open` with `app_token`, holds the WebSocket, acks each envelope by
  `envelope_id`, and reconnects on `disconnect`. The package never sees the socket.
- **`ingress.normalize`**: turns a Socket Mode envelope into `chat-message` records:
  channel posts, mentions, DMs and slash commands. Bot, app and edited-message subtypes are
  skipped. A mention and the matching channel post are delivered as separate records.
- **`chat.channels`**: lists channels for the `x-options` channel picker (D-005).
- **`chat.reply`**: `{ channelId, threadId, text }` → `chat.postMessage` in that thread.

## How it relates to the other Slack plugins

| plugin | what it is | after this package |
|---|---|---|
| `slack-notifier` | Hidden reference plugin. Posts to a Slack **incoming webhook** URL on `mission-done` / `action-failed`. It needs no Slack app, no OAuth and no socket. | **Kept unchanged.** It is the zero-setup outbound option, and it shares no code or credential with this package. If you already have this package connected, a trigger pack can post through `chat.reply` instead. |
| `slack-thread-responder` | Trigger pack. Its trigger binds `ext:slack:mention` (`chat-message`) from the `slack` source this package creates, and its plan replies through the provider-neutral `chat:reply`. | **Runs on this package** (moved in P-008, which deleted the in-app Slack OAuth connection it used to bind). It declares no credential of its own. The reply target is still taken from the triggering record, not from the workflow (see that pack's README). |

Not ported by this package: the in-app "report a bug" gestures (`reaction_added`, the "Report a
bug" message shortcut). They need interactive payloads and reaction events this package does not
declare, so (cupboard-distributable-integrations-2026-10-10#D-019) they stay with the in-app
socket until provider-adapters-to-packages-2026-10-11#P-008 moves them.

## Tests

- `packages/operator-core/lib/providers/slack/slack-package.test.ts`: manifest, normalize,
  channels and reply against a fake Slack API.
- `packages/operator-core/lib/providers/slack/slack-package.integration.test.ts`: the real
  daemon behind the generic socket ingress with PG admission, the channel picker and a reply.
