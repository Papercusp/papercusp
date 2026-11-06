-- Reserved via db:next-migration, deterministic-mission-continuity P-002.
-- Armed after the retained-state/outbox Postgres lifecycle suite passed.
-- State and pending consequences share the retained session row transaction.
ALTER TABLE harness_shared.session_briefs
  ADD COLUMN IF NOT EXISTS mission_continuity jsonb;

COMMENT ON COLUMN harness_shared.session_briefs.mission_continuity IS
  'Versioned enduring assignment, accepted-displacement frames, absolute deadlines and atomic pending consequence receipts. Null means no authoritative binding; never backfilled from intent similarity.';
