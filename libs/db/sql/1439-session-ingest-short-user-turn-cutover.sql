-- Preserve historical accepted-turn indexes when short user decisions become recallable.
-- NULL means the old parser has not yet advanced this file. The first new tail
-- records its existing byte cursor; archives carry that boundary in their manifest.
ALTER TABLE harness_shared.session_ingest_state
  ADD COLUMN IF NOT EXISTS short_user_turns_offset BIGINT;

COMMENT ON COLUMN harness_shared.session_ingest_state.short_user_turns_offset IS
  'First byte parsed with non-empty short user turns retained; immutable after first new tail, copied to archive manifest for stable canonical turn refs.';
