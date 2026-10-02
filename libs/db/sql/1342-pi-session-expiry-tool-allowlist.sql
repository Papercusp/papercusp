-- Bound PI bearers by lifetime and, when supplied, by exact canonical MCP tool
-- names. Existing rows receive a short migration grace period; new sessions
-- always write both fields through startPiSession().
ALTER TABLE harness_shared.pi_sessions
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS allowed_tools jsonb;

UPDATE harness_shared.pi_sessions
   SET expires_at = now() + interval '24 hours'
 WHERE expires_at IS NULL;

ALTER TABLE harness_shared.pi_sessions
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '24 hours'),
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS pi_sessions_live_expiry_idx
  ON harness_shared.pi_sessions (workspace_id, expires_at)
  WHERE ended_at IS NULL;
