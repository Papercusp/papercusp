-- 1540: git_sync_commit_attribution — record the commit time, fix the repo label (WI-6554700010018199).
--
-- The post-sync recorder hardcoded repo='superproject' and let ts default to now(). Git-sync
-- runs once per registered scope and every submodule is its own scope (harness slug
-- '<top>/<submodule path>', its recorder runs `git log` inside the submodule), so every row a
-- submodule scope wrote is a submodule commit mislabelled as a superproject one. ts is the
-- time the row was RECORDED, which lagged the commit by hours during the 2026-10-16..20
-- attribution outage, so per-day queries misplaced commits.
--
-- EXPAND only: a nullable column plus a data backfill. The deployed release never reads
-- committed_at and writes repo itself, so it is unaffected.

ALTER TABLE harness_shared.git_sync_commit_attribution
  ADD COLUMN IF NOT EXISTS committed_at timestamptz;

COMMENT ON COLUMN harness_shared.git_sync_commit_attribution.committed_at IS
  'Committer date of commit_sha (git %cI). NULL on rows recorded before migration 1540: for those only ts, the record time, is known, and it can lag the commit by hours.';
COMMENT ON COLUMN harness_shared.git_sync_commit_attribution.ts IS
  'When the row was RECORDED by the post-sync recorder, not when the commit was made. Use coalesce(committed_at, ts) for commit-time queries.';
COMMENT ON COLUMN harness_shared.git_sync_commit_attribution.repo IS
  '''superproject'', or the submodule path relative to the top-level superproject. file is relative to this repo.';

-- Backfill the repo label of rows written by submodule scopes. A slug with a '/' is a
-- submodule scope of the harness named before the first '/'; every such slug recorded so
-- far (papercusp/libs/papercusp, papercusp/papercusp-desktop, papercusp/libs/generic/*, ...)
-- resolves to a registered submodule whose path is the slug suffix.
UPDATE harness_shared.git_sync_commit_attribution
   SET repo = substr(harness_slug, strpos(harness_slug, '/') + 1)
 WHERE repo = 'superproject'
   AND strpos(harness_slug, '/') > 0;
