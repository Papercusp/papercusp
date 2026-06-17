-- 303-plan-runs-workspace-isolation.sql — workspace-data-isolation-leaks-2026-06-17 F-A2.
--
-- plan_runs / plan_run_turns (scheduled-plan run history + agent transcripts) had
-- NO workspace_id column and were read/written via withWorkspace(DEFAULT_WORKSPACE_ID)
-- (runs.ts) — so a scheduled-plan run + its full transcript created in workspace A
-- were globally visible (plans:runs / plans:run-transcript) in workspace B. Both
-- tables are EMPTY at migration time (verified 0 rows 2026-06-17), so no backfill is
-- needed: add workspace_id + RLS and let the GUC (runs.ts now sets it to the active
-- workspace) isolate them exactly like every other harness_shared.* table.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS / DROP POLICY IF EXISTS); additive; fresh-migrate-safe.

ALTER TABLE harness_shared.plan_runs
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS plan_runs_workspace_idx
  ON harness_shared.plan_runs(workspace_id);

ALTER TABLE harness_shared.plan_run_turns
  ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS plan_run_turns_workspace_idx
  ON harness_shared.plan_run_turns(workspace_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.plan_runs TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.plan_run_turns TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.plan_runs TO harness_zero;
  GRANT SELECT ON harness_shared.plan_run_turns TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.plan_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_runs_workspace_isolation ON harness_shared.plan_runs;
CREATE POLICY plan_runs_workspace_isolation ON harness_shared.plan_runs
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_shared.plan_run_turns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_run_turns_workspace_isolation ON harness_shared.plan_run_turns;
CREATE POLICY plan_run_turns_workspace_isolation ON harness_shared.plan_run_turns
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
