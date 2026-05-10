# @papercupai/gitnexus-bridge

Code-graph queries (symbols, callers, callees, impact analysis, route map) by proxying [GitNexus](https://github.com/abhigyanpatwari/GitNexus)'s MCP server into the Papercusp tool registry.

## What it does

Spawns `npx gitnexus mcp` as a long-lived stdio JSON-RPC child per workspace, queries the upstream tools/list at startup, and forwards every `tools/call` to the child.

The child is reused across many tool invocations (idle TTL: 5 minutes) so repeated queries don't pay the graph-load cost on every call.

## Tools (dynamic — depends on installed gitnexus version)

When upstream is gitnexus 1.6.3 the tools registered are:

| Tool | Purpose |
|---|---|
| `gitnexus.list_repos` | List indexed repositories |
| `gitnexus.query` | Search execution flows by concept (BM25 + semantic) |
| `gitnexus.cypher` | Raw Cypher against the knowledge graph |
| `gitnexus.context` | 360° view of a symbol (callers, callees) |
| `gitnexus.detect_changes` | Map git diff → indexed symbols |
| `gitnexus.rename` | Plan a rename across the graph |
| `gitnexus.impact` | Blast radius of changing a symbol |
| `gitnexus.route_map` | HTTP routes → handlers |
| `gitnexus.tool_map` | Tool definitions (for AI tool/agent code) |
| `gitnexus.shape_check` | Validate request/response shapes vs a route |
| `gitnexus.api_impact` | API change → consumers |
| `gitnexus.group_list` | List configured cross-repo groups |
| `gitnexus.group_sync` | Re-index a group |

## Setup

GitNexus indexes per-repo on disk at `<repo>/.gitnexus/`. Run **once per repo** before the bridge can answer queries about it:

```bash
cd /path/to/your/repo
npx gitnexus analyze
```

The indexed repo is auto-discovered from the `.gitnexus/` folder in the cwd at the time `gitnexus mcp` starts, plus from `~/.gitnexus/registry.json` for repos registered globally. We don't need to tell the bridge about specific repos — gitnexus's `list_repos` tool reports them all.

For multi-repo queries, group them via `gitnexus group create <name>` and reference as `repo: "@<group>"` on tool calls (per upstream docs).

## Capability model

Plugin declares `compute:exec:gitnexus` + `compute:exec:npx` (subprocess execution) and one `tools:gitnexus:<verb>` per upstream tool.

Role allowlist for read-only tools (query, cypher, context, impact, etc.): `operator, architect, reviewer, debugger, scoper, worker, validator`.

Tighter gate for **destructive** tools: `rename` and `group_sync` are limited to `operator, architect` only.

Quotas (for the heavier reads): `worker: perChunk=5`, `architect: perRun=30`, `reviewer/scoper/debugger: perRun=15-20`. Light reads (list_repos, route_map, tool_map, shape_check) are unquoted.

## Architecture notes

- **Children keyed by workspace**, not per-call. The graph load is expensive; spawning per call would be unusable. Idle 5-min TTL kills resident children when nothing's calling them.
- **Tools are registered dynamically** via the `getDynamicTools()` plugin contract extension (5th plugin shape). The bridge probes the upstream's `tools/list` at registration time so the catalog stays in sync with whatever gitnexus version is installed.
- **Bundling** — gitnexus is licensed under PolyForm-Noncommercial-1.0.0. Bundled here per pre-alpha freedom; revisit before any commercial launch.

## Limits

- The bridge currently keeps **one** child per workspace, not per-harness. Cross-harness queries within one workspace share the resident child, which is fine because gitnexus indexes machine-globally.
- `npx --yes gitnexus mcp` first-run fetches the package; subsequent runs use the npx cache. If the cache is wiped, the first call after that pays a ~10s setup cost.
- Patches >4 MiB from gitnexus's underlying git operations are not relevant here (we forward JSON-RPC, not raw diffs); but if a `query` returns a >4 MiB response, the framework may truncate. Use `largeOutput: true` on the manifest entry for that case (already set for query/cypher/impact).
