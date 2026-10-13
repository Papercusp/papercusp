-- Immediate native-edit operations reuse the waiter ticket lifecycle. These
-- records never enter the FIFO queue; their fixed admission deadline makes the
-- existing 24-hour terminal-ticket GC safe against arbitrarily late retries.
ALTER TABLE agent_lock_waiters
  ADD COLUMN IF NOT EXISTS hook_operation jsonb;

