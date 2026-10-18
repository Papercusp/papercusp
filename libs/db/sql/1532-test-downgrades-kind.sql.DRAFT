-- 1532-test-downgrades-kind.sql
-- Plan green-main-ratchet-convergence-2026-10-17, P-008 (R-7, rule R6, scenario S4).
--
-- A test whose verdict differs on the SAME commit is quarantined automatically by the
-- green-checkpoint gate and stops counting toward it. The quarantine reuses the downgrade
-- record (1530): owner, reason, a filed work-item (here the DE-QUARANTINE item, in bug_id),
-- author and time; revoking the row de-quarantines the test. This column tells the two apart,
-- so downgrade metrics (P-010) do not count automatic quarantines as agent downgrades.
--
-- FORWARD-COMPAT: purely additive. The column has a default, so every existing row and every
-- existing INSERT (which names its columns) becomes 'downgrade'; the release deployed on :3070
-- (main d740fc38) has no code that reads or writes test_downgrades at all.

ALTER TABLE harness_shared.test_downgrades
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'downgrade';

DO $z$ BEGIN
  ALTER TABLE harness_shared.test_downgrades
    ADD CONSTRAINT test_downgrades_kind_check CHECK (kind IN ('downgrade', 'flaky-quarantine'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $z$;

COMMENT ON COLUMN harness_shared.test_downgrades.kind IS
  'downgrade = an agent''s written downgrade (P-002). flaky-quarantine = the gate''s automatic quarantine of a test whose verdict flipped on one commit (P-008); bug_id is its de-quarantine work-item.';
