-- 1484: consult_state gains 'no_launchable_responder'.
--
-- consult-backed-parking-2026-10-12 P-003 / bar R-2. A consult where experts
-- WERE selected but no answering session could be launched for any of them
-- used to be stored as 'no_qualified_responder', the same state as a consult
-- where nobody cleared the relevance floor. The two need different follow-up:
-- the first is a dispatch failure, the second is a measured absence. This
-- migration widens the state CHECK so get_feedback can store them apart.
--
-- FORWARD-COMPAT: the constraint is dropped and re-added only to WIDEN its value list; the currently deployed release never writes the new value, and every value it does write stays allowed.

ALTER TABLE harness_shared.consult_state
  DROP CONSTRAINT IF EXISTS consult_state_state_check;

ALTER TABLE harness_shared.consult_state
  ADD CONSTRAINT consult_state_state_check CHECK (state = ANY (ARRAY[
    'routing'::text,
    'no_qualified_responder'::text,
    'no_launchable_responder'::text,
    'awaiting_responder'::text,
    'active'::text,
    'closed_answered'::text,
    'closed_cant_help'::text,
    'declined'::text,
    'graduated'::text,
    'expired'::text
  ]));
