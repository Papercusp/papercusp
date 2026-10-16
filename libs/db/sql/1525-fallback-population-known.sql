-- WI-10004719/P008: unknown cardinality is not a measured empty population.
-- Nullable with no default: old writers remain compatible and old zero-count
-- gate-pass-reuse rows remain explicitly ambiguous to the reader. New writers
-- always specify true (including measured zero) or false (unmeasured).
ALTER TABLE harness_shared.fallback_observations
  ADD COLUMN IF NOT EXISTS population_known boolean;

-- Expand-only, no backfill or validation scan of the shared observation ledger.
ALTER TABLE harness_shared.fallback_observations
  ADD CONSTRAINT fallback_observations_unknown_population_zero
  CHECK (population_known IS DISTINCT FROM FALSE OR (eligible = 0 AND applied = 0)) NOT VALID;

COMMENT ON COLUMN harness_shared.fallback_observations.population_known IS
  'True: measured cardinality, including zero. False: unknown cardinality with zero eligible/applied units. NULL: historical writer; zero-count gate-pass-reuse observations cannot establish measured coverage.';
