-- 1182-session-port-atomic-attempts.sql — one target + replay receipt per
-- session-port attempt, while terminal attempts remain linked and retryable.

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name = 'session_ports'
       AND column_name = 'retry_of_port_id'
  ) THEN
    ALTER TABLE harness_shared.session_ports
      ADD COLUMN retry_of_port_id UUID;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'harness_shared.session_ports'::regclass
       AND conname = 'session_ports_workspace_id_idempotency_key_key'
  ) THEN
    ALTER TABLE harness_shared.session_ports
      DROP CONSTRAINT session_ports_workspace_id_idempotency_key_key;
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF to_regclass('harness_shared.session_ports_active_request_idx') IS NULL THEN
    CREATE UNIQUE INDEX session_ports_active_request_idx
      ON harness_shared.session_ports (workspace_id, idempotency_key)
      WHERE status IN ('prepared', 'pending', 'delivered');
  END IF;

  IF to_regclass('harness_shared.session_ports_retry_idx') IS NULL THEN
    CREATE INDEX session_ports_retry_idx
      ON harness_shared.session_ports (retry_of_port_id)
      WHERE retry_of_port_id IS NOT NULL;
  END IF;
END
$migration$;
