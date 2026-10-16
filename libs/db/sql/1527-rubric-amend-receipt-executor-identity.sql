-- A running amend receipt can outlive the operator worker that owns it. Record
-- enough of that worker's kernel identity for a later status poll or same-key
-- retry to distinguish a live worker from a process killed by service restart.
-- Existing rows remain unknown and continue to use the 15-minute lease.
ALTER TABLE harness_shared.rubric_amend_receipts
  ADD COLUMN IF NOT EXISTS executor_host text,
  ADD COLUMN IF NOT EXISTS executor_pid integer,
  ADD COLUMN IF NOT EXISTS executor_process_id text;

COMMENT ON COLUMN harness_shared.rubric_amend_receipts.executor_host IS
  'Physical host that owned the running amend. NULL means the receipt predates executor identity tracking or the host was unreadable.';

COMMENT ON COLUMN harness_shared.rubric_amend_receipts.executor_pid IS
  'PID of the worker that registered the amend. It is only meaningful when paired with executor_host and executor_process_id.';

COMMENT ON COLUMN harness_shared.rubric_amend_receipts.executor_process_id IS
  'Kernel-backed process identity (linux:<boot-id>:<start-ticks>) of the owning worker; NULL means unknown and preserves lease-only reclaim.';
