-- WI-10006859 / plan app-agent-tasks-durable-execution-2026-10-06 D-017:
-- automatic applied-worker placement for accepted AGENT operations.
--
-- An accepted blueprint operation whose execution.kind is 'agent' can be
-- claimed only by its applied worker (`psu --role <execution.role> --feature
-- <target item>`, bound by bootstrap-role's resolveAcceptedOperationWorkerBinding).
-- Nothing launched that worker, so app operations (email/calendar/phone/crm)
-- were admitted and never ran. The routines tick now places one headless worker
-- per accepted receipt; these columns are its durable claim and retry ledger.
--
-- Expand-only: four nullable/defaulted columns and one partial index. The
-- release still serving :3070 never reads or writes them.

ALTER TABLE harness_shared.blueprint_operation_invocations
  ADD COLUMN IF NOT EXISTS agent_launch_attempts integer NOT NULL DEFAULT 0
    CONSTRAINT blueprint_operation_invocations_agent_launch_attempts_check
    CHECK (agent_launch_attempts >= 0),
  ADD COLUMN IF NOT EXISTS agent_last_launch_at timestamptz,
  ADD COLUMN IF NOT EXISTS agent_launch_owner_id text,
  ADD COLUMN IF NOT EXISTS agent_placement_retired_at timestamptz;

COMMENT ON COLUMN harness_shared.blueprint_operation_invocations.agent_launch_attempts IS
  'Applied-worker placement attempts for an accepted agent operation (WI-10006859). Placement stops after the configured maximum.';
COMMENT ON COLUMN harness_shared.blueprint_operation_invocations.agent_last_launch_at IS
  'When placement last launched a worker for this receipt. A receipt is re-placed only after the retry window and only when that worker is no longer live.';
COMMENT ON COLUMN harness_shared.blueprint_operation_invocations.agent_launch_owner_id IS
  'coord owner id pre-pinned for the most recently placed worker (adv_sessions.coord_owner_id once it boots).';
COMMENT ON COLUMN harness_shared.blueprint_operation_invocations.agent_placement_retired_at IS
  'Placement-scan watermark: set once the receipt can never be placed again (not an agent operation, target terminal or missing, or attempts exhausted). NULL = still considered.';

-- The placement scan rides this index, so each tick costs O(unretired
-- receipts), mirroring blueprint_operation_invocations_unstarted_idx (1237).
CREATE INDEX IF NOT EXISTS blueprint_operation_invocations_agent_unplaced_idx
  ON harness_shared.blueprint_operation_invocations (id)
  WHERE target_kind = 'work-item' AND agent_placement_retired_at IS NULL;

-- Receipts admitted more than 72 hours before placement existed are not
-- launched retroactively. Measured 2026-10-06 19:48Z: the open, unclaimed agent
-- receipts older than that were 10 leftovers of the 2026-10-01/02 P-015 smoke
-- harnesses (p015-smoke-operations*), whose workers would only fail to bind.
-- Newer receipts (the live crm operations) stay placeable.
UPDATE harness_shared.blueprint_operation_invocations
   SET agent_placement_retired_at = now()
 WHERE target_kind = 'work-item'
   AND agent_placement_retired_at IS NULL
   AND created_at < now() - interval '72 hours';
