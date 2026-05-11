# Drizzle migration — Phase 0 audit

**Date:** 2026-05-10
**Source DB:** `papercusp` on localhost:5432 via `harness_admin` role
**Drizzle-kit:** v0.31.10
**Drizzle-orm:** ^0.45.2

## What we pulled

drizzle-kit `introspect` produced:

- `src/schema/generated.ts` — 1942 lines, 125 tables + 4 views
- `src/schema/generated-relations.ts` — relation graph for the 6 declared FKs
- `src/schema/generated.reference.sql` — equivalent CREATE TABLE statements for diff reference

Coverage breakdown:

| Element                  | Count |
|--------------------------|-------|
| Base tables              | 125   |
| Columns                  | 969   |
| Indexes                  | 153   |
| Foreign keys             | 6     |
| RLS policies             | 21    |
| Check constraints        | 21    |
| Views                    | 4     |
| Generated columns (tsv)  | 4     |
| Enums                    | 0     |

## Authority

**The `.sql` files in `./sql/` remain the source of truth for DDL.**
`generated.ts` is a derived mirror. Never run `drizzle-kit generate`
or `drizzle-kit push` against this repo — they would produce broken
DDL for tsvector generated columns, RLS, triggers, and `ALTER
PUBLICATION` calls.

To refresh after a new `.sql` migration:

```bash
node libs/papercusp/libs/db/scripts/pull-schema.mjs
```

The script handles drizzle-kit's known quirks (below) so the output
is committable as-is.

## Drizzle-kit v0.31.10 quirks the pull script works around

### 1. Empty-string defaults emit invalid TypeScript

drizzle-kit writes `.default(')` instead of `.default('')` for any
column whose default is the empty string. **88 occurrences** in our
schema. The pull-schema script rewrites these post-introspection.

### 2. Timestamp mode defaults to 'string'

drizzle-kit emits `timestamp({ withTimezone: true, mode: 'string' })`
by default. The Zero replica requires `mode: 'number'` for timestamptz
(see memory `feedback_zero_pg_timestamptz.md` — wrong mode cascades to
`SchemaVersionNotSupported` and kills WS for the whole schema). The
pull-script rewrites every timestamptz to `mode: 'number'`.

### 3. tsvector + bytea columns are 'unknown'

```ts
// TODO: failed to parse database type 'tsvector'
_search: unknown("_search").generatedAlwaysAs(sql`...`),
```

Harmless for our use: we never read or write `_search` directly from
app code; it's a generated FTS column. Keep the `unknown` typing.
`bytea` only appears on `operator_search_provider_credentials.payload`
which is handled by an explicit JSONB elsewhere — also fine.

### 4. Export naming convention

Every table exports as `<snake_name>InHarness_shared` or
`<snake_name>InPapercup_shared`. Ugly but mechanical. The existing
hand-written `index.ts` uses camelCase (`auditLog`, `projects`, etc.).
**Phase 1 decision:** standardise on the introspected snake_case names
to make the schema fully machine-regenerated. Existing camelCase
re-exports stay as a back-compat layer in `index.ts`.

### 5. Schema-variable naming

`pgSchema("harness_shared")` is assigned to `harness_shared`, not
`harnessShared`. Aligning with #4.

## Audit of UNION-ALL views

drizzle-kit captured all 4 views as `pgSchema.view().as(sql\`...\`)`:

- `harness_shared.operator_decisions` — derived from `audit_log`
- `harness_shared.system_principal_activity` — derived from `audit_log`
- 2 more — confirmed in `generated.ts`

These views can't be in PG publications (memory `project_harness_features_view.md`),
so Zero needs a different path for view-backed UI. Drizzle's view
support is read-only and fine here.

## What's NOT covered (carries forward to Phase 4 "raw SQL territory")

- Trigger functions (`needs_design` BEFORE INSERT, etc.) — drizzle-kit
  doesn't introspect triggers. Stays in `sql/`.
- `ALTER PUBLICATION zero_harness ADD TABLE …` — DDL only, no schema
  representation. Stays in `sql/`.
- `LISTEN/NOTIFY` channels (`sync_invalidate`, etc.) — runtime only,
  not schema. Stays in `sync-sse.ts` + `pending-events-listener.ts`.
- Per-harness `harness_<slug>.*` schemas. Per-workspace dynamic
  schemas created at runtime via `pgSchema()` factory; introspection
  only sees `harness_shared` + `papercup_shared`. The factory pattern
  in `index.ts` (`harnessTables(slug)`) covers this.

## Phase 0 status: ✅ done

- [x] Live DB introspected
- [x] `generated.ts` committed
- [x] `generated-relations.ts` committed
- [x] `drizzle.config.ts` committed
- [x] `pull-schema.mjs` committed with quirk fixups
- [x] Existing `index.ts` audited for divergence (5 tables present
      out of 125; rest will route via re-exports from `generated.ts`
      in Phase 1)

## Up next (Phase 1)

Wire `getOrgPg().db` + `getHarnessPg(slug).db` to return a Drizzle
instance bound to `generated.ts`. Hand-written `auditLog` etc. in
`index.ts` become camelCase re-exports of the introspected names.
Existing `.sql` raw call sites untouched. New code can opt in.

See memory `project_drizzle_migration_plan.md` for the full plan.
