-- conclusive-blind-review-recovery-2026-10-23 P-001, D-002.
-- The runner executes this migration atomically. ALTER holds ACCESS EXCLUSIVE
-- until commit: existing receipts get v1, while inserts after the boundary
-- (including old writers omitting both fields) get v2 before writers resume.
-- No UPDATE: preserve append-only historical material and timestamps.
ALTER TABLE harness_shared.plan_blind_reviews
  ADD COLUMN protocol_version integer NOT NULL DEFAULT 1,
  ADD COLUMN outcome text CHECK (outcome IN ('conclusive', 'inconclusive'));

ALTER TABLE harness_shared.plan_blind_reviews
  ALTER COLUMN protocol_version SET DEFAULT 2;

COMMENT ON COLUMN harness_shared.plan_blind_reviews.protocol_version IS
  '1: pre-upgrade completed-post provenance; 2: explicit outcome required for acceptance. Unknown versions fail closed.';
COMMENT ON COLUMN harness_shared.plan_blind_reviews.outcome IS
  'Review completion outcome. NULL is tolerated for old writers but never qualifies a v2 review for acceptance.';
