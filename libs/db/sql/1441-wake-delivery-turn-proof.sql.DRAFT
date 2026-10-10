-- 1441: wake-delivery turn-start proof (parked-agent-census-resumption-and-root-cause-2026-10-09
-- P-006 / WI-10008157, decision D-004).
--
-- status='delivered' only ever meant "handed to a channel": an inbox write, a pty write, a spawned
-- resume process. Measured 2026-10-10 (24h): 13,131 of 21,970 inbox deliveries and 259 of 1,119
-- psu-socket-inject deliveries were followed by no tool_use from the recipient within 10 minutes,
-- and every one of them read back as a clean success. turn_proof carries the separate question
-- "did a turn actually start":
--
--   host-attested  the psu host replied 'delivered' under requireNativeTurnStart (its
--                  native-turn-start-confirmed event), or quota-recovery pickup was confirmed
--   observed       a real-time turn signal from the recipient after delivered_at
--   awaiting       no proof yet; resolved by the pump before pickup_deadline_at
--   not-picked-up  pickup_deadline_at passed with no signal
--   superseded     coalesced / suppressed-redundant: the content rides another delivery
--
-- NULL = a row booked before this migration (unknown, never read as either outcome).
-- Additive only: every column is nullable with no default, so the release still serving :3070
-- (which never writes these columns) is unaffected.

ALTER TABLE harness_shared.event_wake_deliveries
  ADD COLUMN IF NOT EXISTS turn_proof text,
  ADD COLUMN IF NOT EXISTS turn_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS pickup_deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS pickup_escalated_at timestamptz;

-- NOT VALID: the 551k existing rows are all NULL, so a validation scan proves nothing; new and
-- updated rows are still checked.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'event_wake_deliveries_turn_proof_check'
       AND conrelid = 'harness_shared.event_wake_deliveries'::regclass
  ) THEN
    ALTER TABLE harness_shared.event_wake_deliveries
      ADD CONSTRAINT event_wake_deliveries_turn_proof_check
      CHECK (turn_proof IS NULL OR turn_proof = ANY (ARRAY[
        'host-attested', 'observed', 'awaiting', 'not-picked-up', 'superseded'
      ]::text[])) NOT VALID;
  END IF;
END $$;

-- The pump's pickup sweep reads only the awaiting set, oldest deadline first.
CREATE INDEX IF NOT EXISTS idx_event_wake_deliveries_pickup_awaiting
  ON harness_shared.event_wake_deliveries (pickup_deadline_at)
  WHERE turn_proof = 'awaiting';

COMMENT ON COLUMN harness_shared.event_wake_deliveries.turn_proof IS
  'P-006/D-004: did this delivery start a turn. host-attested | observed | awaiting | not-picked-up | superseded; NULL = booked before migration 1441. Independent of status, which only says the delivery was handed to a channel.';
COMMENT ON COLUMN harness_shared.event_wake_deliveries.turn_started_at IS
  'When the turn-start proof was established (host attestation time or first observed turn signal).';
COMMENT ON COLUMN harness_shared.event_wake_deliveries.pickup_deadline_at IS
  'Awaiting rows resolve to not-picked-up after this instant (delivered_at + PAPERCUSP_WAKE_PICKUP_WINDOW_SEC, default 600).';
COMMENT ON COLUMN harness_shared.event_wake_deliveries.pickup_escalated_at IS
  'Set when a not-picked-up delivery was handed to host recovery (at most once per delivery).';
