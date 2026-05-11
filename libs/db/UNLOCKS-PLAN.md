# Drizzle migration — post-migration unlocks plan

The Phase 0–4 migration (see `MIGRATION-COMPLETE.md`) shipped the substrate.
This plan turns that substrate into application-visible wins. The order is
load-bearing: each item compounds on the previous one.

The core insight: **Drizzle schema isn't just guardrails — it's a substrate**.
Anywhere the codebase has hand-written JSON Schema / form / admin page /
fixture / MCP tool input / card payload duplicating DB shape, Drizzle
collapses them to one source.

---

## Unlock 1 — `drizzle-zod` across plugin SDK + API routes

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
1. Add `drizzle-zod` to `libs/papercusp/libs/db/package.json`.
2. Emit `libs/papercusp/libs/db/src/schema/zod.ts` from the same `pull-schema.mjs` pipeline:
   - For every generated table, export `<name>InsertZ`, `<name>SelectZ`, `<name>UpdateZ`.
   - This is purely additive — `generated.ts` stays untouched.
3. Pick three high-value routes for the proof-of-concept:
   - `app/api/operator/budget-tiers` (POST) — server validation.
   - `app/api/internal/test-snapshot` — body shape per row, replaces `TEST_ID_RE` / `VALID_PHASES` hand-rolls.
   - `app/api/dev/drizzle-studio` (already exists; add request body schema once we add params).
4. Audit `lib/forms/makeAjvResolver` callers; convert each to `zodResolver(insertSchema)` where the form maps to a single table.
5. Plugin SDK: in `packages/orchestrator/src/plugin-sdk.ts`, expose `pluginConfigSchemaFromTable(t)` helper that wraps `createInsertSchema(t).strip()` so plugin manifests can reference an existing schema by table name instead of inlining JSON.
6. CI: extend the existing `zero-drift-check` script with a `zod-drift-check.mjs` that fails if `zod.ts` is stale vs `generated.ts`.

**Risk surface:** small. `drizzle-zod` is additive; the existing hand-authored schemas keep working until each call site is migrated.

**Effort:** ~1 day for the generator + 3 proof-of-concept routes; ~2 more days to migrate the long tail.

---

## Unlock 2 — Schema-aware `/dev` table inspector

**Why second:** Drizzle Studio (just shipped) covers 80% of the value, but
we still want a deeper, in-app inspector that knows about our specific
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

**Why third:** depends on Unlock 1 for the Zod schemas. Once those exist,
generating an admin page for a new table is ~10 lines.

**What it gives us:**
- `<TableAdmin table={generated.hidden_pluginsInHarness_shared} />` renders a paginated grid, an edit form (from the insert Zod), and audit history if `mtime_ms` is present.
- Replaces several hand-written admin pages: `hidden_plugins`, `operator_budget_tiers`, `operator_settings`, `harness_features`.
- Plugins can ship admin pages without writing UI code — just declare the tables they own.

**Steps:**
1. Build a `TableAdmin` component in `apps/operator/app/_components/admin/`:
   - Props: `{ table, where?, allowEdit?, allowDelete?, capabilities? }`.
   - Renders: filterable RichGrid + `RowDrawer` form generated from `createInsertSchema(table)` via `react-hook-form` + `zodResolver`.
2. Generic API route `app/api/admin/[table]/route.ts` that:
   - Maps URL slug → `generated[slug]`.
   - Validates body via `createInsertSchema(table)` / `createUpdateSchema(table)`.
   - Checks `capabilities.canEditTable(slug, user)` before any write.
3. Move existing one-off admin pages (`hidden_plugins`, `operator_budget_tiers`, `operator_settings`) to `<TableAdmin table={generated.<table>} />` and delete the bespoke code.
4. Plugin SDK addition: plugins declare `adminTables: ['<name>']` in their manifest; the operator surfaces a per-plugin admin tab automatically.

**Risk surface:** medium — the generic API route needs careful capability checks. RLS already enforces workspace; we add a `canEditTable` registry to gate the destructive ops.

**Effort:** ~4 days including the capability layer.

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
