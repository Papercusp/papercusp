-- 1558 — accelerate literal filePath filters in testing:runs.
--
-- The reader uses file_path ILIKE '%literal%' to preserve substring semantics.
-- Its btree file_path index cannot serve a leading-wildcard predicate. Small/fresh
-- ledgers get the GIN inline; populated ledgers defer to the existing guarded
-- sessionSearchIndexBuild workflow, which builds GIN indexes concurrently and
-- handles low disk, long transactions, and invalid leftovers.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$
DECLARE
  test_runs_small boolean;
BEGIN
  SELECT count(*) <= 10000
    INTO test_runs_small
    FROM (SELECT 1 FROM harness_shared.test_runs LIMIT 10001) AS probe;

  IF test_runs_small THEN
    EXECUTE $sql$CREATE INDEX IF NOT EXISTS test_runs_file_path_substring_trgm_idx
      ON harness_shared.test_runs USING gin (file_path gin_trgm_ops)$sql$;
  END IF;
END $$;
