-- 294-papercup-projects-row.sql
--
-- WI-148 / P-013 (workspace-identity reconciliation) — SAFE forward prep ONLY.
--
-- Ensure a `papercup` row exists in harness_shared.projects keyed to the
-- papercusp-workspace sentinel ('papercusp-workspace'). harness_shared.projects
-- is the AUTHORITATIVE slug→workspace_id mapping (migration 221 leg 1: "the
-- registry; authoritative where present"; UNIQUE (workspace_id, slug)) — the
-- same table fill_workspace_id_from_projects() reads. Today papercup self-
-- registers only in the harness_registry BLOB (register-papercup.ts), which
-- carries NO workspace_id, so the projects table has no papercup row at all.
-- This adds it so the eventual lookup has something to resolve.
--
-- WHY THIS IS HARMLESS NOW (NOT the gated cutover):
--   The resolution code (fill_workspace_id_from_projects / resolvePlanScope)
--   short-circuits papercup / '*' / 'all' / empty to DEFAULT_WORKSPACE_ID
--   ('default') and NEVER consults this row — by hard invariant, until the
--   owner-gated "part B" flip + lockstep data move ships. So inserting the
--   papercusp-workspace mapping changes NO resolution today; it is pure prep.
--   Flipping resolution to read this row BEFORE moving papercup's plan/decision/
--   revision rows (all under workspace_id='default') would 404 every papercup
--   plan — that move is part B, out of scope for this migration.
--
-- Idempotent: ON CONFLICT (workspace_id, slug) DO NOTHING — a re-run, or a row
-- already present (e.g. created by a future part-B path), is a no-op. We do NOT
-- touch any existing papercup row under workspace_id='default'.

INSERT INTO harness_shared.projects (
    id, name, status, slug, created_ts, updated_ts, workspace_id
)
VALUES (
    'PROJ-papercup-papercusp-workspace',
    'papercup',
    'active',
    'papercup',
    (extract(epoch from now()) * 1000)::bigint,
    (extract(epoch from now()) * 1000)::bigint,
    'papercusp-workspace'
)
ON CONFLICT (workspace_id, slug) DO NOTHING;
