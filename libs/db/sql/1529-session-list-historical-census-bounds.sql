-- Migration 1528 — bound the cross-workspace sessions:list historical census.
--
-- EI-26085092190939594 measured six historical-census backends retaining the
-- same xmin for about 3,412 seconds while a seven-day EXPLAIN estimated 5.26M
-- rows and chose sequential scans of agent_activity and tool_invocations.
-- sessions:list now installs an 8s transaction-local statement_timeout; these
-- indexes make the bounded timestamp legs selective before that deadline.
--
-- The migration runner wraps each file in one transaction, so these are normal
-- CREATE INDEX statements rather than CREATE INDEX CONCURRENTLY. On an already
-- large live table, pre-build the same definitions concurrently before applying
-- this migration; IF NOT EXISTS makes the migration a no-op after that build.

CREATE INDEX IF NOT EXISTS session_turns_workspace_ts_historical_idx
  ON harness_shared.session_turns (workspace_id, ts DESC)
  WHERE owner IS NOT NULL
    AND session_id IS NOT NULL
    AND ts IS NOT NULL;

COMMENT ON INDEX harness_shared.session_turns_workspace_ts_historical_idx IS
  'sessions:list historical census: workspace plus non-null turn timestamp window';

CREATE INDEX IF NOT EXISTS session_turns_workspace_ingested_historical_idx
  ON harness_shared.session_turns (workspace_id, ingested_at DESC)
  WHERE owner IS NOT NULL
    AND session_id IS NOT NULL
    AND ts IS NULL;

COMMENT ON INDEX harness_shared.session_turns_workspace_ingested_historical_idx IS
  'sessions:list historical census fallback: workspace plus ingested_at window for turns without ts';

CREATE INDEX IF NOT EXISTS agent_activity_workspace_created_historical_idx
  ON harness_shared.agent_activity (workspace_id, created_at DESC);

COMMENT ON INDEX harness_shared.agent_activity_workspace_created_historical_idx IS
  'sessions:list historical census: workspace plus activity created_at window';

CREATE INDEX IF NOT EXISTS tool_invocations_workspace_invoked_historical_idx
  ON harness_shared.tool_invocations (workspace_id, invoked_at DESC)
  INCLUDE (coord_owner_id)
  WHERE coord_owner_id IS NOT NULL;

COMMENT ON INDEX harness_shared.tool_invocations_workspace_invoked_historical_idx IS
  'sessions:list historical census: workspace plus invocation time window for owner-bearing calls';
