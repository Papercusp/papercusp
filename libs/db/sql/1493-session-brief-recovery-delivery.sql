-- 1493: digest of the post-compaction recovery legs a carry document delivered.
-- Plan oversized-tool-results-reduction-2026-10-12 D-006 (EI-23452465962348473).
--
-- buildCarryDoc writes { v, builtAt, buildEpoch, planAuthority, checkpoints } here.
-- A later coord:orient { afterCompaction: true } compares it with the live recovery
-- and replaces unchanged legs with a re-fetch pointer, but only when exactly one
-- memory-epoch bump happened after the build (that bump is the context wipe the
-- carry document was delivered across). Nullable: ordinary launches and older
-- readers are unchanged, and a missing value always means "deliver in full".

ALTER TABLE harness_shared.session_briefs
  ADD COLUMN IF NOT EXISTS recovery_delivery jsonb;

COMMENT ON COLUMN harness_shared.session_briefs.recovery_delivery IS
  'Digest of the recovery legs the latest carry document delivered (D-006); read by coord:orient afterCompaction to avoid re-sending unchanged plan authority and held-item checkpoints.';
