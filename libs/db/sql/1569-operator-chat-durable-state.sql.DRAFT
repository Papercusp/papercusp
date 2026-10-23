-- shared-chat-scout-papercup-2026-10-22 P-010. Extend the existing turn log,
-- rather than introducing a second chat/session/event/decision store.
-- NULL means legacy0; the host must explicitly initialize a version1 record.
-- Keep this additive so old readers/writers can coexist during rollout.
ALTER TABLE harness_shared.operator_turns
  ADD COLUMN IF NOT EXISTS chat_state JSONB;

COMMENT ON COLUMN harness_shared.operator_turns.chat_state IS
  'Version1 shared chat checkpoint, bounded event replay and interaction decisions. NULL is legacy0, never an implied resumable turn.';
