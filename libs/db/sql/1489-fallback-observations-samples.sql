-- 1489: harness_shared.fallback_observations.samples (WI-6554700010009713).
--
-- observeFallback now coalesces identical decisions (same workspace, mechanism,
-- reason, scope and process tag, no correlation id) observed within one flush
-- debounce into ONE row, so a row may stand for N decisions. Before this, the
-- three hottest mechanisms (cache-l2-operation, merge-cursor-seed,
-- spawner-sidecar-exec) wrote one row per successful call: ~12.5M rows/day,
-- which under the 14-day retention (BAR R-12 of
-- degradation-signals-on-condition-rail-2026-10-11) projects to ~41 GB.
-- Readers count decision batches as sum(samples), no longer count(*).
--
-- Expand-only: an older writer that omits the column gets the default 1, which
-- is exactly what its one-row-per-decision rows mean, and an older reader's
-- count(*) only under-counts samples (a display field; no threshold reads it).

ALTER TABLE harness_shared.fallback_observations
  ADD COLUMN IF NOT EXISTS samples integer NOT NULL DEFAULT 1;

-- NOT VALID: every existing row takes the constant default 1, which satisfies
-- the check, so skip the full validation scan of a ~12M-row table under the
-- ALTER's exclusive lock. New and updated rows are still checked.
ALTER TABLE harness_shared.fallback_observations
  ADD CONSTRAINT fallback_observations_samples_positive CHECK (samples >= 1) NOT VALID;

COMMENT ON COLUMN harness_shared.fallback_observations.samples IS
  'Decision batches this row stands for: identical observations within one writer flush window are coalesced (eligible/applied are their sums). Count batches as sum(samples), never count(*).';
