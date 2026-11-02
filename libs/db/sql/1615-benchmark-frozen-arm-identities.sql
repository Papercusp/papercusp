-- Current benchmark protocols freeze their own named arm roster (stock, solo,
-- coordinated, repeated-session, and future preregistered controls). The legacy
-- four-name enum predates that protocol and rejects valid results on insertion.
-- Keep arm identity nonblank here; emitRollout enforces exact membership in the
-- immutable preregistered protocol before writing either transaction row.
-- Existing rows remain valid. Reapplication is safe and changes no result data.
-- FORWARD-COMPAT: the nonblank check is a strict superset of the four legacy
-- arm names; old and current writers remain valid. Drop and replacement happen
-- in one ALTER TABLE in the runner transaction, with no unconstrained window.
ALTER TABLE harness_shared.benchmark_run_result
  DROP CONSTRAINT IF EXISTS benchmark_run_result_arm_check,
  ADD CONSTRAINT benchmark_run_result_arm_check
    CHECK (arm ~ '[^[:space:]]');
