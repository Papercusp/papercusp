# @papercupai/jira-sync

Sync Papercusp harness state to a Jira Cloud project.

## What it does

Three actions:

| Action | What |
|---|---|
| `create-issue` | Create a Jira issue with auto-label `papercusp-<harness-slug>` |
| `post-comment` | Append a comment to any issue by key |
| `list-issues` | JQL-search; defaults to `labels = papercusp-<slug>` |

## Surfaces

| Surface | Action |
|---|---|
| `harness-toolbar` | `create-issue` (manual button) |
| `feature-row` | `create-issue` + `post-comment` (per-feature actions) |
| `mission-done` | `create-issue` (auto-runs, summary configurable) |
| `plugin-detail` | `list-issues` |

## Configuration

Set three environment variables in the substrate process:

```sh
export JIRA_BASE_URL=https://yourorg.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...   # https://id.atlassian.com/manage-profile/security/api-tokens
```

The substrate's capability gate (`secrets:read:JIRA_*`) makes sure the plugin only sees these three vars, not your full env.

Plugin-level config (in `<state>/plugins/jira-sync/config.json`):

```json
{
  "defaultProjectKey": "ENG",
  "defaultIssueType": "Task",
  "labelPrefix": "papercusp",
  "createOnFeaturePassed": false
}
```

## Capabilities declared

- `secrets:read:JIRA_API_TOKEN`
- `secrets:read:JIRA_EMAIL`
- `secrets:read:JIRA_BASE_URL`
- `http:fetch:*.atlassian.net`
- `events:listen:feature-passed`
- `events:listen:feature-failed`
- `events:listen:proposal-accepted`
- `events:listen:mission-done`

## Compared to slack-notifier

| | `slack-notifier` | `jira-sync` |
|---|---|---|
| Auth | Single webhook URL | Three secrets (token + email + base URL) |
| Encoding | Direct webhook POST | Basic auth with base64-encoded `email:token` |
| Body | Plain text | Atlassian Document Format (ADF) for descriptions/comments |
| Surfaces | Toolbar + mission-done | Toolbar + feature-row + mission-done + plugin-detail |
| Idempotency | None needed (fire-and-forget) | Pass `idempotencyKey` (e.g. feature_id); plugin auto-labels and find-before-creates |

## Idempotency

Pass `idempotencyKey` to `create-issue`:

```json
{
  "summary": "Feature F-042: add bulk export",
  "projectKey": "ENG",
  "idempotencyKey": "F-042"
}
```

The plugin labels the issue `papercusp-key-F-042` and JQL-searches for any existing issue with that label first. If found, returns the existing issue's key with `result.reused: true`; otherwise creates a new one with `result.reused: false`. Re-running the action — from a retry, an event replay, or a cron-triggered routine — won't pile up duplicates.

Recommended source for the key: the harness's `feature_id`. That makes one Jira issue track one harness feature across its entire lifecycle.

## TODO

- Wire `createOnFeaturePassed` config into feature-passed event handler
- Add transition support (Draft → In Progress → Done) on status changes
- ADF rich-content encoder for code blocks / lists / mentions

## Source

`libs/papercusp/plugins/jira-sync/` — TypeScript source.

Marketplace tarball at `~/.papercusp/marketplace-storage/@papercupai/jira-sync/0.1.0/jira-sync-0.1.0.tar.gz`.

## License

MIT
