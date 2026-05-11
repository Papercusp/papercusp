# Drizzle migration — post-migration unlocks plan

The Phase 0–4 migration (see `MIGRATION-COMPLETE.md`) shipped the substrate.
This plan turns that substrate into application-visible wins. The order is
load-bearing: each item compounds on the previous one.

The core insight: **Drizzle schema isn't just guardrails — it's a substrate**.
Anywhere the codebase has hand-written JSON Schema / form / admin page /
fixture / MCP tool input / card payload duplicating DB shape, Drizzle
collapses them to one source.

---

## How drizzle types help our MCP/HTTP wrapper

The MCP tool wrapper (`packages/agent-mcp/src/define-tool.ts`) already takes
a Zod schema for tool arguments — that schema serves both runtime validation
and JSON Schema generation for `tools/list`. Drizzle types compound with it
three ways:

**1. Args schemas for write tools.** Today a "create goal" MCP tool would
hand-write `z.object({ title: z.string(), body: z.string().optional(), ... })`
mirroring `goals` columns. With `schemaOf(generated.goalsInHarness_shared).insert`
the args schema *is* the column shape — NOT NULL becomes required, SQL
defaults become optional, generated columns are omitted. One source of truth.

**2. Response row types.** Every list/get tool currently returns
`Array<Record<string, unknown>>`. With `z.infer<typeof schemaOf(t).select>`
the response shape is the column shape. The agent sees a typed row, MCP
clients can validate the response against the same schema the server used.

**3. Typed Drizzle queries replace raw SQL.** 20 of 28 first-party MCP
tools currently use `ctx.tx<Array<Record<string, unknown>>>\`SELECT ...\``.
Wrapping `ctx.tx` with `drizzle(ctx.tx)` gives the full typed query
builder while preserving the workspace GUC the RLS layer needs (the
transaction sets the GUC, drizzle just routes queries through it).

See `packages/agent-mcp/src/tools/goals/{get,list}.ts` for the worked
example: 27 lines became 35 lines but the response shape is now typed
end-to-end, and adding a new column to `goals` automatically appears in
the tool's output without any code change.

A `defineTableTool` higher-order helper (auto-derives args from a table
+ a CRUD mode) is the natural next step — it would collapse the 20 raw-SQL
tools to ~5-line declarative definitions:

```ts
defineTableTool({
  name: 'goals:create',
  table: generated.goalsInHarness_shared,
  mode: 'insert',
  capability: 'goals:write',
  handler: async (insertRow, ctx) => { ... }
})
```

That helper is queued as part of Unlock 3 (the CRUD admin factory), which
already needs the same insert/update/delete primitives.

---

## Unlock 1 — `drizzle-zod` across plugin SDK + API routes + MCP tools

**Status: foundation shipped** (`libs/papercusp/libs/db/src/schema/zod.ts` +
`schemaOf()` exports + `goals:get`/`goals:list` proof of concept). Remaining
work is incremental migration of consumers.


**Why first:** biggest correctness + DX win, and every later unlock benefits
from it. Today plugin JSON Schemas are hand-authored and validated with ajv
via `lib/forms/makeAjvResolver`. The schemas drift from the column types
they describe.

**What it gives us:**
- One source of truth per table: `createInsertSchema(t)`, `createSelectSchema(t)`, `createUpdateSchema(t)` from `drizzle-zod`.
- Plugin config schemas authored as `z.object({ ... }).extend(insertSchema)` instead of JSON.
- API route handlers get `.parse()` for free on every body, with the same Zod schemas the forms use.
- `react-hook-form` + `zodResolver(insertSchema)` gives typed forms with zero duplication.

**Steps:**
1. ~~Add `drizzle-zod` to `libs/papercusp/libs/db/package.json`.~~ ✅ Done.
2. ~~Emit a runtime helper at `libs/papercusp/libs/db/src/schema/zod.ts` instead of code-gen — `schemaOf(table)` returns `{ insert, select, update }` zod schemas on demand.~~ ✅ Done. Code-gen rejected because the runtime form is cheaper (~ms per table at import) and never drifts.
3. Pick three high-value routes for the proof-of-concept:
   - `app/api/operator/budget-tiers` (POST) — server validation.
   - `app/api/internal/test-snapshot` — body shape per row, replaces `TEST_ID_RE` / `VALID_PHASES` hand-rolls.
   - `app/api/dev/drizzle-studio` (already exists; add request body schema once we add params).
4. Audit `lib/forms/makeAjvResolver` callers; convert each to `zodResolver(insertSchema)` where the form maps to a single table.
5. Plugin SDK: in `packages/orchestrator/src/plugin-sdk.ts`, expose `pluginConfigSchemaFromTable(t)` helper that wraps `createInsertSchema(t).strip()` so plugin manifests can reference an existing schema by table name instead of inlining JSON.
6. **MCP tools** (new): use `schemaOf(table).select` as the response row type for any tool that lists/gets rows from a table. Use `.insert` / `.update` as the args schema for any tool that writes. See `packages/agent-mcp/src/tools/goals/{get,list}.ts` for the pattern.

**Why MCP wins here:** every tool that touches a table currently has
hand-typed `Array<Record<string, unknown>>` returns and bespoke Zod args.
20 of 28 MCP tools fall into this bucket. Switching to `schemaOf(t).select`
gives the agent's response a typed shape that matches the actual columns —
no more "this row may or may not have `goal_id`" because the column
nullability is encoded in the Zod schema.

**Risk surface:** small. `drizzle-zod` is additive; the existing hand-authored schemas keep working until each call site is migrated.

**Effort:** foundation done. Pattern toolkit ready. Remaining tail (~50 call sites: 20 MCP tools + 30 API routes + ajv form callers) is incremental at ~5 min per site.

---

## Unlock 2 — Schema-aware `/dev` table inspector

**Status: MVP shipped.** `/dev` Tables tab lists all 129 introspected
tables grouped by schema (`harness_shared` / `papercup_shared`), shows
columns with PG types + nullability + defaults + PK + FKs + indexes,
and serves a paginated row grid with admin-role / app-role toggle.
API: `GET /api/dev/tables`, `GET /api/dev/tables/[exportName]`,
`GET /api/dev/tables/[exportName]/rows`. Sibling of the embedded Drizzle
Studio tab; this one knows our app conventions (workspace scoping, RLS
bypass), Studio doesn't.

**Deferred follow-ons:** Monaco SQL composer, FK-walk navigation
(jump from a row to its references), per-row "Open in" menu that routes
to a harness page when the FK is `harness_slug`, WHERE composer that
builds Drizzle queries from drop-downs.

**Why this unlock:** Drizzle Studio covers 80% of the value, but we
still want a deeper, in-app inspector that knows about our specific
patterns — workspace scoping, RLS bypass mode, the harness/operator
domains. Drizzle Studio doesn't know any of that.

**What it gives us:**
- Click any of the 125 tables → columns, FKs, generated cols (tsvector marked), defaults, RLS status, indexes.
- Monaco SQL editor with real per-FROM autocomplete sourced from `generated.ts`.
- FK-walk navigation (jump from one row to its references).
- Diff inspector with column-type-aware rendering (jsonb pretty, tsvector hidden, bigint as number/Date depending on column name).
- Workspace switcher that injects the GUC at the connection level.

**Steps:**
1. New `/dev` tab "Tables" (sibling to "Drizzle Studio"). Lists all tables grouped by schema; click → table view.
2. Drive UI from runtime introspection of `getTableConfig(t)` on every export from `generated.ts` — no codegen needed.
3. Row grid via the existing `RichGrid` (preserves theming + virtualization).
4. WHERE composer that builds Drizzle queries from drop-downs (column, op, value); falls back to a Monaco SQL editor for free-form.
5. Per-row "Open in" menu: jump to the related row via FK, or open a precomputed harness page if the FK is `harness_slug`.
6. RLS toggle in the right rail — flips between `getOrgPg()` (admin, bypasses RLS) and `getOrgPgApp()` (app role, enforces RLS).

**Risk surface:** none — purely additive read-only UI.

**Effort:** ~3 days. Most of the cost is in the WHERE composer; the row grid is mostly RichGrid wiring.

---

## Unlock 3 — Auto-generated CRUD admin UI factory

**Status: API factory shipped.** UI React component deferred to a follow-up.

`lib/admin-tables.ts` is the registry — `registerAdminTable({ exportName,
table, label, editableColumns?, allowDelete? })`. First-party entries:
`operator_budget_tiers`, `operator_settings`, `hidden_plugins`. Plugins
extend at boot.

`/api/admin/tables` (GET list of registered) and
`/api/admin/tables/[exportName]` (GET=list rows, POST=insert,
PATCH=update by PK, DELETE=remove by PK). Body validation via
`schemaOf(table).insert / .update`. Editable-column filter strips
sensitive columns from bodies even when the registry lists the table.

Verified live: full CRUD round-trip on `operator_budget_tiers` —
GET → 3 rows, POST → row 99 with zod validation rejecting bad types,
DELETE → 1 row removed.

**Deferred:** `<TableAdmin table=...>` React component (form factory
via `useFormWith(schemaOf(t).insert)` + RichGrid). The thread between
Zod 4's deep recursive types and `react-hook-form`'s resolver needs a
narrower type at the call site; doable but worth a focused turn.

**Why this unlock:** new tables → admin pages in ~10 lines. Replaces
several hand-written admin pages: `hidden_plugins`, `operator_budget_tiers`,
`operator_settings`. Plugins ship admin pages without writing UI code —
just declare the tables they own.

**Risk surface:** localhost-only (operator binds 127.0.0.1); same threat
model as `/dev`. Editable-column filter is the privilege-escalation
guard.

---

## Unlock 4 — `drizzle-zero` auto-derivation

**Why fourth:** the current Zero schema is auto-generated by
`libs/zero-harness/scripts/generate-schema.mjs` from `generated.ts` plus
a 76-entry rename map (Option A from the migration plan). The migration
shipped that. The cleanup work — replacing the custom generator with
`drizzle-zero` — lives here.

**What it gives us:**
- Removes the 76-entry rename map; relations and types come from Drizzle.
- One fewer custom script to maintain.
- Easier to add per-role schemas later (which `drizzle-zero` supports natively).

**Steps:**
1. Spike `drizzle-zero` against the current `generated.ts` in a branch; confirm the rename map collapses to a `casing: 'camelCase'` flag.
2. Diff its output against `libs/zero-harness/src/schema.ts`; reconcile any divergences with `zero-drift-check.mjs`.
3. Replace `generate-schema.mjs` invocation in CI with `drizzle-zero`.
4. Delete the rename map.

**Risk surface:** medium — Zero schema is consumer-facing for every `useQuery` call site. Test path: run drift check + visit every dashboard view before retiring the old generator.

**Effort:** ~2 days for the spike + 1 day for the swap, if drizzle-zero matches.

---

## Unlock 5 — `makeFixture(table, overrides)` helper

**Status: shipped** in `libs/test-config/src/make-fixture.ts` with
`makeFixture(t, overrides?)` + `makeFixtures(t, count, overridesFor?)` +
9 passing tests covering NOT NULL satisfaction, override precedence,
nullable defaults, hasDefault omission (DB fills it), jsonb-default-{},
bigint-timestamp-defaults, and batch generation. Exported from
`@papercusp/test-config`.

Migration tail: drop the existing hand-written factories one at a time
as tests need maintenance.

**Why last:** small but high-leverage. Replaces ~30 hand-written test factories.

**What it gives us:**
- `const f = makeFixture(generated.harness_testsInHarness_shared, { harness_slug: 'x' })` returns a row with typed defaults derived from column types + defaults declared in `generated.ts`.
- Tests stop drifting from schema changes.
- Property-based testing via `fast-check` becomes feasible: derive a generator per column type.

**Steps:**
1. Add `libs/test-config/src/makeFixture.ts`:
   - Walk `getTableConfig(table).columns`.
   - For each column: use the SQL default if present; otherwise pick a sensible per-type default (text → "", integer → 0, jsonb → {}, bigint → 0, timestamptz → `new Date(0)`).
   - Merge `overrides`.
2. Add a `makeFixtures(table, count, overrides)` batch variant for grid tests.
3. Migrate the 30 highest-traffic factories (start with `__tests__/fixtures/`).

**Risk surface:** none — test-only.

**Effort:** ~1 day for the helper + ~2 days of incremental factory migration.

---

## Nice-to-haves (build only when relevant pain shows up)

- **Operator card / directive payload auto-derivation** — cards that wrap "row in T changed" pull their payload type from `createSelectSchema(T)`.
- **Plugin manifest column references + capability enforcement at write time** — plugins declare `writesTo: ['table.column']`; the SDK rejects unauthorized writes.
- **Auto-generated `/docs/db` reference page** — render `generated.ts` as a browsable schema doc.
- **Schema diff in CI (drizzle-kit-based breaking-change detector)** — fail PRs that change a column type without a migration.
- **Per-role Zero schema generation from RLS metadata** — unlock follows Unlock 4.
- **Property-based testing via fast-check generators from Drizzle types** — unlock follows Unlock 5.

---

## Out of scope (explicit non-goals)

- Anything requiring per-harness schema awareness at compile time (runtime `pgSchema()` is the answer; static narrowing would need codegen-at-boot).
- Replacing the `.sql` migration files with `drizzle-kit generate` — raw SQL DDL remains the source of truth (see `MIGRATION-COMPLETE.md` §"Permanent raw-SQL").

---

## Suggested first PR

Unlock 1, scoped to:
1. Add `drizzle-zod` dep.
2. Extend `pull-schema.mjs` to emit `zod.ts`.
3. Convert `test-snapshot` route to use `createInsertSchema(harness_testsInHarness_shared)` for body validation.
4. Add `zod-drift-check.mjs` to the CI matrix.

That PR is ~150 lines, low-risk, and immediately demonstrates the pattern. Every later unlock builds on it.
