-- 218: workspace-scope harness_shared.plan_revisions (full-app-audit P-008).
--
-- plan_revisions was the one Plans-family table with NO workspace_id column
-- and NO RLS policy (its siblings — harness_plans, plan_runs, … — have both,
-- and harness-state/table-registry.ts already classifies it "§7.4 LOCAL
-- Plans = workspace-scoped"). Every revision therefore landed in one global
-- spine: two same-slug plans in different workspaces would interleave one
-- seq sequence, and a non-default workspace could read another workspace's
-- revision history.
--
-- All existing rows were written under the default workspace context, so
-- backfilling the new column with 'default' is exact, not a guess.
--
-- Idempotent: column add IF NOT EXISTS, guarded constraint swap, policy
-- re-created.

ALTER TABLE harness_shared.plan_revisions
  ADD COLUMN IF NOT EXISTS workspace_id text NOT NULL DEFAULT 'default';

-- seq uniqueness is per (workspace, harness, plan) — swap the old
-- (harness_slug, plan_slug, seq) key for the workspace-scoped one.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'plan_revisions_harness_slug_plan_slug_seq_key'
       AND conrelid = 'harness_shared.plan_revisions'::regclass
  ) THEN
    ALTER TABLE harness_shared.plan_revisions
      DROP CONSTRAINT plan_revisions_harness_slug_plan_slug_seq_key;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'plan_revisions_ws_harness_plan_seq_key'
       AND conrelid = 'harness_shared.plan_revisions'::regclass
  ) THEN
    ALTER TABLE harness_shared.plan_revisions
      ADD CONSTRAINT plan_revisions_ws_harness_plan_seq_key
        UNIQUE (workspace_id, harness_slug, plan_slug, seq);
  END IF;
END $$;

-- Same isolation shape as every other workspace-scoped harness_shared table.
ALTER TABLE harness_shared.plan_revisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_revisions_workspace_isolation ON harness_shared.plan_revisions;
CREATE POLICY plan_revisions_workspace_isolation ON harness_shared.plan_revisions
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
