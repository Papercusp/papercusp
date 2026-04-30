# @papercupai/linear-sync

Sync Papercusp harness state to a Linear team.

## What it does

Three actions:

| Action | What |
|---|---|
| `create-issue` | Create a Linear issue with auto-label `papercusp-<harness-slug>` |
| `post-comment` | Append a comment to any issue by UUID or identifier (e.g. `ENG-42`) |
| `list-issues` | Filter by label; defaults to `papercusp-<slug>` |

## Surfaces

| Surface | Action |
|---|---|
| `harness-toolbar` | `create-issue` (manual button) |
| `feature-row` | `create-issue` + `post-comment` (per-feature actions) |
| `mission-done` | `create-issue` (auto-runs, summary configurable) |
| `plugin-detail` | `list-issues` |

## Configuration

Set one environment variable in the substrate process:

```sh
export LINEAR_API_KEY=lin_api_...   # https://linear.app/settings/api
```

Personal API keys go in bare; OAuth bearer tokens with the `Bearer ` prefix are passed through as-is. The substrate's capability gate (`secrets:read:LINEAR_API_KEY`) makes sure the plugin only sees this one var.

Plugin-level config (in `<state>/plugins/linear-sync/config.json`):

```json
{
  "defaultTeamKey": "ENG",
  "labelPrefix": "papercusp",
  "createOnFeaturePassed": false
}
```

`defaultTeamId` (UUID) bypasses the team-key lookup if you'd rather hard-code it.

## Capabilities declared

- `secrets:read:LINEAR_API_KEY`
- `http:fetch:api.linear.app`
- `events:listen:feature-passed`
- `events:listen:feature-failed`
- `events:listen:proposal-accepted`
- `events:listen:mission-done`

## Compared to jira-sync

| | `jira-sync` | `linear-sync` |
|---|---|---|
| Auth | Three secrets (token + email + base URL), Basic-auth | One secret (`LINEAR_API_KEY`), bearer-style |
| Transport | REST + ADF for rich text | GraphQL + Markdown for descriptions/comments |
| Project addressing | Project key (e.g. `ENG`) | Team UUID, or team key resolved via GraphQL |
| Labels | Strings; created implicitly by Jira | Must exist as `IssueLabel` rows; plugin auto-creates missing ones on the team |
| Idempotency | Label `papercusp-key-<id>` + JQL find | Label `papercusp-key-<id>` + GraphQL filter find |

## Idempotency

Pass `idempotencyKey` to `create-issue`:

```json
{
  "title": "Feature F-042: add bulk export",
  "teamKey": "ENG",
  "idempotencyKey": "F-042"
}
```

The plugin labels the issue `papercusp-key-F-042` and queries Linear for any existing issue with that label first. If found, returns `result.reused: true` with the existing identifier; otherwise creates a new one with `result.reused: false`. Re-running the action — from a retry, an event replay, or a routine — won't pile up duplicates.

Recommended source for the key: the harness's `feature_id`.

## API endpoints

- `GET /api/plugins/_papercupai_linear-sync/ping` — liveness + `configured` flag
- `GET /api/plugins/_papercupai_linear-sync/viewer` — proves credentials by fetching the authenticated viewer + org

## TODO

- Wire `createOnFeaturePassed` config into feature-passed event handler
- Optional state-transition mapping (Linear workflow states ↔ harness statuses)
- Project / cycle / assignee fields on `create-issue`

## License

MIT
