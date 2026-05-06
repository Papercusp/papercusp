-- 017-harness-shared-phase-and-proposal-cols.sql
--
-- Phase 2.5 mirror tables grew columns that the Zero schema definition
-- references but the runtime DB doesn't have. The columns are added by
-- apps/operator/lib/ensure-schema.ts at startup, but ensure-schema is
-- gated on the harness fs-watcher actually loading — and any unrelated
-- compile error in lib/harness-fs-watcher.ts blocks it. Result: every
-- /api/zero-harness/rest-query for proposalsShared / featuresSheets /
-- issuesSheets / agentRunsSheets / pendingReviews returns
-- 500 "Schema incompatibility detected" until ensure-schema runs.
--
-- This migration codifies the additive changes so a fresh DB or a
-- repaired existing DB can match the Zero schema without depending on
-- ensure-schema firing at the right time.

-- harness_summaries: add `phase` for staging/testing/production triple-mirror.
ALTER TABLE harness_shared.harness_summaries
  ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'staging';

-- pending_reviews: add `phase`.
ALTER TABLE harness_shared.pending_reviews
  ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'staging';

-- harness_proposals_shared: full set of Phase 2.5 columns.
ALTER TABLE harness_shared.harness_proposals_shared
  ADD COLUMN IF NOT EXISTS phase           TEXT NOT NULL DEFAULT 'staging',
  ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS review_verdict  TEXT,
  ADD COLUMN IF NOT EXISTS review_summary  TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at     BIGINT,
  ADD COLUMN IF NOT EXISTS applied_at      BIGINT,
  ADD COLUMN IF NOT EXISTS rejected_at     BIGINT,
  ADD COLUMN IF NOT EXISTS size_bytes      BIGINT NOT NULL DEFAULT 0;
