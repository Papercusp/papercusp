-- current-benchmark-modernization-2026-10-09 P-001 / WI-10007924.
-- Extend the existing run lifecycle: archived submissions awaiting official
-- grades are not completed results and are not active generation/grading jobs.
-- No new store and no rewrite of historical execution data.
-- Verified by external-bench/run-store.integration.test.ts and the boot preapply lint.
-- FORWARD-COMPAT: replacement preserves every existing status and only adds ungraded; deployed readers/writers retain their statuses and no column or data is removed. The runner replaces the check atomically in its own transaction.
ALTER TABLE harness_shared.bench_runs
    DROP CONSTRAINT IF EXISTS bench_runs_status_check;
ALTER TABLE harness_shared.bench_runs
    ADD CONSTRAINT bench_runs_status_check
    CHECK (status IN ('pending', 'running', 'grading', 'ungraded',
                      'done', 'error', 'cancelled'));
