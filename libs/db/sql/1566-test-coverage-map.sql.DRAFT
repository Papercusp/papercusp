-- P016 optional per-test-FILE V8 observations. Status remains in test_runs;
-- run_group_id + test_file joins that ledger. No test-case attribution is implied.
CREATE TABLE IF NOT EXISTS harness_shared.test_coverage_maps (
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  root_path text NOT NULL,
  scope_root text NOT NULL,
  test_file text NOT NULL,
  observed_at timestamptz NOT NULL,
  run_group_id text,
  snapshot jsonb NOT NULL CHECK (octet_length(snapshot::text) <= 300000),
  PRIMARY KEY (workspace_id, harness_slug, root_path, scope_root, test_file)
);
CREATE INDEX IF NOT EXISTS test_coverage_maps_retention_idx
  ON harness_shared.test_coverage_maps (workspace_id, harness_slug, observed_at DESC);
COMMENT ON TABLE harness_shared.test_coverage_maps IS
  'Optional V8 test-file coverage. Writer retains at most 2000 latest rows per workspace/harness and seven days; readers reject stale/source-mismatched or incomplete absence evidence. No release verdict.';
