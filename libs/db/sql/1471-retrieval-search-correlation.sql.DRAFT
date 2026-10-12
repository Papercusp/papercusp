-- Exact search-to-observation joins for retrieval degradation investigations.
-- This stays orthogonal to `scope`, which remains the mechanism's alarm grouping key.
ALTER TABLE harness_shared.fallback_observations
  ADD COLUMN correlation_id uuid;

COMMENT ON COLUMN harness_shared.fallback_observations.correlation_id IS
  'Optional exact per-call correlation key joining a fallback observation to its tool_invocations metadata receipt; never used as the alarm scope.';

CREATE INDEX fallback_observations_correlation_id_idx
  ON harness_shared.fallback_observations (correlation_id)
  WHERE correlation_id IS NOT NULL;
