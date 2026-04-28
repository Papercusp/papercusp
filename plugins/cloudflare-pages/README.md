# @papercupai/cloudflare-pages

First server-runtime Papercusp reference plugin. Publishes the harness's static
export to Cloudflare Pages on `mission-done` (or via the toolbar action).

Reference implementation for spec §14.7 P6 — exercises the action primitive +
capability-gated secret reads + outbound HTTP.

## Install

```sh
papercusp install @papercupai/cloudflare-pages --harness <slug>
papercusp plugin enable @papercupai/cloudflare-pages --harness <slug>
```

You'll be prompted for `accountId` + `projectName`.

## Capabilities (consent prompt)

- `secrets:read:CLOUDFLARE_API_TOKEN` — reads the token from the harness
  credential store at runtime.
- `http:fetch:api.cloudflare.com` — outbound to Cloudflare's API only.
- `ui:dashboard-tab` — surfaces a "Cloudflare Pages" tab.
- `events:listen:mission-done` — receives the mission-done event.

## Action: `publish`

- Surfaces: `mission-done`, `harness-toolbar`.
- Server-runtime, default timeout 120s.
- Honors `AbortSignal`: in-flight fetches are cancelled if the substrate
  trips the timeout.
- Idempotent: re-triggering with the same `triggerId` returns the prior
  result without re-publishing.

```ts
// Programmatic call (what the substrate does on mission-done):
await registry.invoke({
  name: 'publish',
  ctx,
  params: { dryRun: false },
  triggerSource: 'routine',
  triggerId: missionRunId,
});
```

## Dry-run

```sh
# Operator can dry-run from the CLI:
papercusp plugin invoke @papercupai/cloudflare-pages publish --dry-run
```

(The `invoke` CLI command is not part of P6 — added later.)
