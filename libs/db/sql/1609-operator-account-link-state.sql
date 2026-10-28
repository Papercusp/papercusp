-- EI-270045: reuse operator-state transactions for bounded nonsecret CLI link
-- metadata and CAS custody. Never store tokens, device codes or PTY output.
CREATE TABLE IF NOT EXISTS harness_shared.operator_account_link_state (
  workspace_id TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at BIGINT NOT NULL DEFAULT 0
);
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_account_link_state TO harness_app;
GRANT SELECT ON harness_shared.operator_account_link_state TO harness_zero;
ALTER TABLE harness_shared.operator_account_link_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS operator_account_link_state_workspace_isolation ON harness_shared.operator_account_link_state;
CREATE POLICY operator_account_link_state_workspace_isolation ON harness_shared.operator_account_link_state
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
