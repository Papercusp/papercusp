-- WI-10003631 (P-013 workload C): make the accepted coord-program launch scan
-- O(unstarted receipts) instead of O(all receipts ever accepted).
--
-- findUnstartedAcceptedCoordPrograms previously seq-scanned every
-- blueprint_operation_invocations row (filtered only by target_kind) and paid a
-- work_items index probe plus a dbos.workflow_status anti-join per row, on every
-- launch pass. Receipts are retained indefinitely, so launch cost grew without
-- bound with history.
--
-- program_started_at is a launch-scan WATERMARK, not outcome authority: the
-- scan stamps it once a receipt's workflow exists (or its target work item is
-- terminal), and the dbos.workflow_status anti-join remains the correctness
-- guard. A NULL value only means "the scan has not yet observed this receipt as
-- launched", so a crash between workflow start and the stamp is harmless.
ALTER TABLE harness_shared.blueprint_operation_invocations
  ADD COLUMN IF NOT EXISTS program_started_at timestamptz;

COMMENT ON COLUMN harness_shared.blueprint_operation_invocations.program_started_at IS
  'Launch-scan watermark: set once the receipt''s coord-program workflow exists or its target work item is terminal. NULL = still a launch candidate. The dbos.workflow_status anti-join remains the correctness guard.';

CREATE INDEX IF NOT EXISTS blueprint_operation_invocations_unstarted_idx
  ON harness_shared.blueprint_operation_invocations (id)
  WHERE target_kind = 'work-item' AND program_started_at IS NULL;
