-- 1415: data_sources.participant_backfill_cursor — resume point for the participant backfill
-- (crm-agent-sales-onboarding-apps-2026-10-06 P-003, decision D-018; WI-10006999).
--
-- The participant backfill (packages/operator-core/lib/relationship-graph/participant-backfill.ts
-- runPendingParticipantBackfills) runs inside the system:connector-sync routine. It used to walk
-- EVERY stored interaction of a pending source in one call, keeping its position only in memory, so
-- a large mailbox held the routine's tick for many minutes and no connector sync ran meanwhile
-- (measured 2026-10-06 after migration 1413 re-granted person -> record: no sync pass logged from
-- 22:29:48Z for more than 20 minutes). The backfill now works under a per-tick time budget and
-- records where it stopped here, so the next tick continues from that point instead of starting over.
--
-- Shape: {"kind": "<personal_documents.kind>", "afterId": "<personal_documents.id>"} — the last
-- document processed, in (kind, id) order. NULL = start from the beginning. Cleared when the backfill
-- completes (participant_backfill_at is stamped) and whenever the source newly grants
-- person -> record, so a re-grant starts over, the same rule migration 1394 applies to the marker.
--
-- Additive only: a nullable column and a replaced trigger function body; no existing column changes.

ALTER TABLE harness_shared.data_sources
  ADD COLUMN IF NOT EXISTS participant_backfill_cursor jsonb;

COMMENT ON COLUMN harness_shared.data_sources.participant_backfill_cursor IS
  'D-018 / WI-10006999: where the participant backfill stopped for this source''s current person->record grant, {"kind","afterId"}; NULL = not started or complete. Cleared with participant_backfill_at when the grant is newly added.';

CREATE OR REPLACE FUNCTION harness_shared.data_sources_reset_participant_backfill()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(NEW.destination_policy -> 'person', '[]'::jsonb) @> '["record"]'::jsonb
     AND NOT (coalesce(OLD.destination_policy -> 'person', '[]'::jsonb) @> '["record"]'::jsonb) THEN
    NEW.participant_backfill_at := NULL;
    NEW.participant_backfill_cursor := NULL;
  END IF;
  RETURN NEW;
END
$$;
