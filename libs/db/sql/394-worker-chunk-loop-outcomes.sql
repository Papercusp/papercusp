-- 394-worker-chunk-loop-outcomes.sql — worker-chunk-loop-operator-hosted-2026-06-14 P-020.
--
-- worker_chunk_loop_outcomes — ONE row per runWorkerChunkLoop() call (a feature
-- attempt), the durable record the dark-launch parity diff + the ramp metrics gate on.
--
-- WHY a new table (reuse-first checked): the ChunkLoopOutcome kind
-- (completed/planning_failed/escalated/aborted) + its execution PATH (subprocess vs the
-- operator-hosted op) are recorded NOWHERE structured today — the outcome collapses into
-- harness_features_consolidated.status ('validating' | 'failing'), which loses both the
-- kind AND the path. harness_run_output lacks outcome_kind and is written ONLY by the
-- subprocess exit (the in-process op never spawns/exits), so it can't capture both arms.
-- Both paths converge on runWorkerChunkLoop(); this table is written at that one site.
--
-- Conventions mirror harness_chunk_plans EXACTLY (same RLS workspace-isolation policy +
-- explicit workspace_id writes), because the chunk loop ALREADY persists chunk_plans
-- through the SAME ctx.pg in BOTH the subprocess and op paths — so a table written the
-- same way behaves identically (no new RLS/session risk).
--
-- Idempotent (CREATE … IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.worker_chunk_loop_outcomes (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY,
  workspace_id       TEXT NOT NULL,
  harness_slug       TEXT NOT NULL,
  feature_id         TEXT NOT NULL,
  execution_path     TEXT NOT NULL,              -- 'subprocess' | 'op'
  outcome_kind       TEXT NOT NULL,              -- completed | planning_failed | escalated | aborted
  chunks_committed   INT,                         -- completed: chunks committed this run
  replan_strikes     INT,                         -- escalated: replan strikes spent
  escalated_chunk_id TEXT,                         -- escalated: the chunk that exhausted strikes
  detail             TEXT,                         -- error/reason excerpt (clamped), nullable
  created_ts         BIGINT NOT NULL DEFAULT ((EXTRACT(epoch FROM now()) * (1000)::numeric))::bigint,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS worker_chunk_loop_outcomes_recent_idx
  ON harness_shared.worker_chunk_loop_outcomes (workspace_id, harness_slug, created_ts DESC);
CREATE INDEX IF NOT EXISTS worker_chunk_loop_outcomes_path_idx
  ON harness_shared.worker_chunk_loop_outcomes (workspace_id, execution_path, outcome_kind);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.worker_chunk_loop_outcomes TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.worker_chunk_loop_outcomes TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.worker_chunk_loop_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS worker_chunk_loop_outcomes_workspace_isolation ON harness_shared.worker_chunk_loop_outcomes;
CREATE POLICY worker_chunk_loop_outcomes_workspace_isolation ON harness_shared.worker_chunk_loop_outcomes
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
