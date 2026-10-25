-- 1576: restrict the empty-result health rollup's time scan to code:run rows.
-- EI-26942275834086274: the seven-day aggregate scanned the cross-tool telemetry
-- index and filtered tool_name after fetching heap rows, observed on DataFileRead
-- for over a minute. The predicate is the reader's literal tool spelling.
-- Keep metadata_json out of the index: the aggregate reads its marker from the
-- much smaller matching heap population rather than copying JSON payloads here.
--
-- The runner is transactional. For a large live table, pre-build this exact
-- definition with CREATE INDEX CONCURRENTLY, then apply the idempotent migration.

CREATE INDEX IF NOT EXISTS tool_invocations_code_run_time_idx
  ON harness_shared.tool_invocations (invoked_at DESC)
  WHERE tool_name = 'code:run';

COMMENT ON INDEX harness_shared.tool_invocations_code_run_time_idx IS
  'EI-26942275834086274: selective code:run time-window rollups without cross-tool heap filtering or metadata payload duplication';
