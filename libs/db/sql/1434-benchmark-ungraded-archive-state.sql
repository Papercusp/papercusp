-- current-benchmark-modernization-2026-10-09 P-001 / WI-10007924.
-- Extend the existing run lifecycle: archived submissions awaiting official
-- grades are not completed results and are not active generation/grading jobs.
-- No new store and no rewrite of historical execution data.
-- Verified by external-bench/run-store.integration.test.ts before arming.
BEGIN;
ALTER TABLE harness_shared.bench_runs
    DROP CONSTRAINT IF EXISTS bench_runs_status_check;
ALTER TABLE harness_shared.bench_runs
    ADD CONSTRAINT bench_runs_status_check
    CHECK (status IN ('pending', 'running', 'grading', 'ungraded',
                      'done', 'error', 'cancelled'));
COMMIT;
