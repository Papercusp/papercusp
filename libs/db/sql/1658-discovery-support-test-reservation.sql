-- A changed Discovery finding and its accepted test share one background run.
-- The insert winner records the caller and original subject before launch.
ALTER TABLE harness_shared.testing_run_snapshots
  ADD COLUMN IF NOT EXISTS discovery_check jsonb;

COMMENT ON COLUMN harness_shared.testing_run_snapshots.discovery_check IS
  'Immutable Discovery test reservation with its measured subject, registered test and original actor.';
