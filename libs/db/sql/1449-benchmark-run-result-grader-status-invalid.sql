-- 1449: allow grader_status = 'invalid' on harness_shared.benchmark_run_result.
--
-- Plan benchmark-coverage-frontierswe-v2-2026-10-10 D-008 (P-020). A pre-grade evidence-integrity check
-- that finds an attempt's protected verifier/scorer/fixture paths changed refuses to score it. That
-- verdict is a canonical GraderStatus ('invalid'): a missing measurement disclosed as its own count,
-- never stored as 'error' (the row has no other column that could tell the two apart).
--
-- FORWARD-COMPAT: the replacement constraint is a strict superset of the one it drops, so every row the deployed release can write still passes; the deployed release never writes 'invalid', and the drop and re-add run in one ALTER TABLE inside the runner's transaction, so no window exists without the constraint.
--
-- No top-level BEGIN/COMMIT: the migration runner wraps each file.

ALTER TABLE harness_shared.benchmark_run_result
  DROP CONSTRAINT IF EXISTS benchmark_run_result_grader_status_check,
  ADD CONSTRAINT benchmark_run_result_grader_status_check
    CHECK (grader_status IN ('passed', 'failed', 'error', 'timeout', 'invalid'));
