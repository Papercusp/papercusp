-- Migration 1478 — per-case results for every recorded test file run
-- (plan test-rubric-unification-2026-10-12, P-001 / R-1).
--
-- WHY. harness_shared.test_runs holds one row per test FILE per run. A rubric check
-- or a spec-evidence binding that names one test case ("this `it` proves R-x") had no
-- per-case history to resolve against: execution_details carries bounded title lists
-- (failedCaseTitles / passedCaseTitles, capped and dropped on mixed outcomes), never
-- every case with its own status and duration. This table records each case the
-- Vitest reporter (libs/test-config/src/admin-test-runs-reporter.ts) observed in a
-- module, keyed to the test_runs row that module produced.
--
-- IDENTITY. A case is (test_runs.file_path, case_key, occurrence): case_key is
-- Vitest's fullName ("describe > nested > it"), the repo path lives on the parent
-- row, and occurrence (1-based) separates parameterized cases that reuse a fullName
-- within one module. case_index is the case's position in module order and forms the
-- primary key with the parent id, so the key stays narrow (no text in the btree).
--
-- RETENTION. No separate prune: ON DELETE CASCADE follows harness_shared.prune_test_runs
-- (keep 50 runs per file + branch, daily DBOS workflow) and the EI-5366 orphan prune,
-- both of which DELETE parent rows. The primary key's leading test_run_id serves the
-- cascade lookups.
--
-- VOLUME. Measured 2026-10-12: ~39k test_runs rows/day averaging ~22 cases each, so
-- ~0.85M case rows/day before retention; the 50-runs-per-file cap bounds the table.
--
-- Idempotent: safe to re-run. Applied by the runner (`db:migrate`), never a raw psql -f.

CREATE TABLE IF NOT EXISTS harness_shared.test_case_runs (
  test_run_id  bigint  NOT NULL REFERENCES harness_shared.test_runs(id) ON DELETE CASCADE,
  case_index   integer NOT NULL CHECK (case_index >= 0),
  case_key     text    NOT NULL CHECK (length(case_key) BETWEEN 1 AND 2000),
  occurrence   integer NOT NULL DEFAULT 1 CHECK (occurrence >= 1),
  status       text    NOT NULL CHECK (status IN ('pass', 'fail', 'skip')),
  duration_ms  integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error_tail   text    CHECK (error_tail IS NULL OR length(error_tail) <= 1000),
  PRIMARY KEY (test_run_id, case_index)
);

COMMENT ON TABLE harness_shared.test_case_runs IS
  'One row per Vitest test case observed in a recorded test_runs module (migration 1478). Identity: parent file_path + case_key + occurrence. Pruned by cascade from test_runs.';
COMMENT ON COLUMN harness_shared.test_case_runs.case_key IS
  'Vitest fullName: describe/it title path joined with " > ".';
COMMENT ON COLUMN harness_shared.test_case_runs.occurrence IS
  '1-based ordinal among cases sharing case_key in the same module run (parameterized tests).';
COMMENT ON COLUMN harness_shared.test_case_runs.error_tail IS
  'First error of a failed case, formatted by formatTestCaseError, at most 1000 chars.';

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.test_case_runs TO harness_app;
