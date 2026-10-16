# Mastodon provider

Install through Cupboard and connect through Integrations. Save application client
credentials for the chosen instance. The host owns the connection origin, account
identity, tokens, egress restriction, and publish approval.

Home timeline and mention history use `max_id`; subsequent gaps use `min_id` to
walk forward without discarding the middle. IDs stay opaque. Cursors are bound to
their connection and resume mid-walk. Versions include `edited_at` when returned.
There is no replayable stream or guarantee of discovering historical edits omitted
by the server's incremental feed. A page bound refuses rather than reporting a
truncated catch-up as complete.

Posts and replies forward the host's `Idempotency-Key` unchanged (retained by
Mastodon for up to one hour). The package never retries writes. Neutral `followers`
maps to Mastodon's `private`. Deletion reads ownership first: another account's
status is an auth failure; an absent status returns `deleted:false`. Media uploads
are not supported.

The maintained TypeScript source reuses the existing HTML converter. Rebuild the
installable bundle and stdio launcher from the repository root:

```sh
node packages/plugin-sdk/scripts/build-provider-daemons.mjs libs/papercusp/plugins/mastodon
```

Primary contracts reviewed 2026-10-16: https://docs.joinmastodon.org/methods/timelines/#home,
https://docs.joinmastodon.org/methods/notifications/#get,
https://docs.joinmastodon.org/methods/statuses/ and https://docs.joinmastodon.org/entities/Status/.
