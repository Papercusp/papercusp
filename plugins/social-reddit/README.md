# Reddit — platform trigger pack

Watches the connected account's comment replies, mentions and submissions.

Installing this pack wires the Reddit connection once — credential, identifier
and every event Reddit emits — instead of binding each event by hand.

## What it binds

| binding | fires on |
|---|---|
| `reddit-post` | `ext:reddit:post` |
| `reddit-reply` | `ext:reddit:reply` |
| `reddit-mention` | `ext:reddit:mention` |

Each event is its OWN binding so you can arm just the ones you want — mentions
without posts, comments without uploads — from the triggers admin without
editing the pack.

Bindings are shipped **disarmed**. Arming is a separate, deliberate step.

## Storm policy

`30` runs per `300`s, derived from this platform's
`read` budget in the social platform registry — not a number chosen here. The
registry is the single source, and `starter-packs.test.ts` recomputes it and
fails if this manifest drifts from it.

## Connection

Install the `reddit` provider and connect your account through Integrations. Register
your Reddit app and save its client ID, secret and truthful application User-Agent
on the host. Select that connection as `redditApp`; the pack never holds app secrets.
Reddit may require API access approval. This pack does not scan arbitrary subreddits.

## Share semantics

Per-field, per the `configSchema` convention:

- `redditApp` — `secret: true`, `snapshotPolicy: "strip"`, `shareable: false`.

⚠ These flags are a **declaration**, and today only the plugin-sdk validator
enforces them (and only on an OAuth field). The snapshot exporter that once
acted on them is retired, so nothing strips these values at share time yet —
tracked as EI-21277461137556587. Credentials are encrypted at rest in
`harness_shared.plugin_configs` regardless.

## What it does NOT do

No write path is requested: the plan records the event and stops. For drafting a
reply see `@papercupai/social-mention-triage`; for a periodic roll-up see
`@papercupai/social-comment-digest`.

