-- 1632: fan-out retry state on harness_shared.substrate_outbox
-- (shared-reference-system-2026-11-13 P-003, closes EI-28590608042464896).
--
-- Before this migration the drain caught a failed or timed-out local
-- subscribe->inject fan-out, logged it, and then stamped drained_at anyway, so the
-- failed fan-out was never retried: the notification was silently lost while the
-- row looked delivered. Federation must keep moving (fan-out is local-only), so the
-- row still drains; these columns carry the fan-out's OWN retry state, independent
-- of federation progress.
--
--   fanout_retry_at    epoch ms of the next fan-out retry (same clock as
--                      drained_at). NULL = no retry pending, which is the state of
--                      every existing row, so no backfill is needed.
--   fanout_attempts    failed fan-out attempts so far for this row.
--   fanout_last_error  last fan-out error message (kept after the retry budget is
--                      exhausted, so a given-up row stays diagnosable).
--
-- Additive only (nullable / defaulted columns + a non-unique partial index), so the
-- currently-deployed release keeps working unchanged.

ALTER TABLE harness_shared.substrate_outbox
  ADD COLUMN IF NOT EXISTS fanout_retry_at bigint,
  ADD COLUMN IF NOT EXISTS fanout_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS fanout_last_error text;

COMMENT ON COLUMN harness_shared.substrate_outbox.fanout_retry_at IS
  'P-003: epoch ms of the next local fan-out retry; NULL = no retry pending. Independent of drained_at (federation).';
COMMENT ON COLUMN harness_shared.substrate_outbox.fanout_attempts IS
  'P-003: failed local fan-out attempts for this row.';
COMMENT ON COLUMN harness_shared.substrate_outbox.fanout_last_error IS
  'P-003: last local fan-out error; retained after the retry budget is exhausted.';

-- The retry sweep reads only rows with a pending retry, per tenant, oldest due first.
CREATE INDEX IF NOT EXISTS substrate_outbox_fanout_retry_idx
  ON harness_shared.substrate_outbox (workspace_id, harness_slug, fanout_retry_at, id)
  WHERE fanout_retry_at IS NOT NULL;
