-- 1480-plan-now-note.sql
--
-- derived-status-not-hand-written-2026-10-12 P-004 (WI-6554700010009033),
-- decisions D-007 and D-008.
--
-- WHAT CHANGES
--   A plan's Now note (the hand-written state/next judgment) stops being a
--   `## Now` markdown section that plans:set-now rewrites into `content`. It is
--   stored as one structured jsonb value, harness_plans.now_note:
--     { state, next, author, writtenAt, eventId, source: 'set-now' }
--   eventId is the msg_id of the plan's `now_updated` plan event (the note's
--   position in the plan-event log); writtenAt is the note's own clock, and a
--   newer writtenAt wins when a peer's note is applied. now_state / now_next
--   stay as the projection of the resolved note.
--
-- NO BACKFILL (existing Now sections migrate on read)
--   A plan with now_note NULL is read from its content `## Now` section, which
--   now_state / now_next already hold, so an existing note is not lost; the first
--   plans:set-now writes the field and the content section is frozen from then
--   on. A backfill UPDATE was measured and rejected: run in a rolled-back
--   transaction against the live database on 2026-10-12 it touched 2,173 rows
--   and took 112 s, because every UPDATE of a plan row recomputes the stored
--   generated `_search` tsvector over the whole content. That is ~2 minutes of
--   blocked plan writes fleet-wide at boot for a value the read fallback already
--   provides.
--
-- FEDERATION
--   capture_substrate_outbox_upd_trg gains now_note in its WHEN list, so a
--   note-only write is captured as a whole-row op (D-008).
--
-- Additive only (ADD COLUMN, CREATE OR REPLACE TRIGGER): the currently-deployed
-- release never reads now_note and keeps working; the trigger change only adds a
-- condition under which an UPDATE is captured.

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS now_note jsonb;

COMMENT ON COLUMN harness_shared.harness_plans.now_note IS
  'The plan''s Now note as structured fields (derived-status-not-hand-written-2026-10-12 '
  'P-004): {state, next, author, writtenAt, eventId, source}. Written by plans:set-now '
  'without touching content; a newer writtenAt wins on federation apply. NULL = no note '
  'written yet: readers fall back to the content ## Now section (now_state / now_next).';

CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
  AFTER UPDATE ON harness_shared.harness_plans
  FOR EACH ROW
  WHEN (
       (old.content IS DISTINCT FROM new.content)
    OR (old.content_hash IS DISTINCT FROM new.content_hash)
    OR (old.title IS DISTINCT FROM new.title)
    OR (old.status IS DISTINCT FROM new.status)
    OR (old.created IS DISTINCT FROM new.created)
    OR (old.updated IS DISTINCT FROM new.updated)
    OR (old.owner IS DISTINCT FROM new.owner)
    OR (old.supersedes IS DISTINCT FROM new.supersedes)
    OR (old.superseded_by IS DISTINCT FROM new.superseded_by)
    OR (old.archived IS DISTINCT FROM new.archived)
    OR (old.is_legacy IS DISTINCT FROM new.is_legacy)
    OR (old.now_note IS DISTINCT FROM new.now_note)
  )
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('plan_slug');
