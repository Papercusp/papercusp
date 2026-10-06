-- Operation private input (plan app-agent-tasks-durable-execution-2026-10-06
-- D-014, WI-10006699). A blueprint operation may declare privateInputSchema:
-- content the submitter hands to the worker WITHOUT putting it in the work-item
-- payload (which is replay-hashed and outlives the app's own content deletion,
-- e.g. a Phone call transcript under phone D-022).
--
-- One row per operation invocation, keyed by the invocation's natural key
-- (blueprint_operation_invocations UNIQUE). It is written BEFORE the work item
-- is accepted, so a worker can never claim an item whose private input is not
-- yet readable. content_text is the EXACT serialization the service hashed
-- (JSON.stringify of the submitted value), kept as text rather than jsonb so
-- sha256(content_text) stays reproducible: jsonb would reorder object keys and
-- re-space the text.
--
-- Lifetime: reads refuse once the operation's work item is terminal; the
-- 15-minute triggerDeliveryRetention DBOS workflow deletes rows whose work item
-- is terminal or whose expires_at has passed (no new scheduler).
CREATE TABLE IF NOT EXISTS harness_shared.blueprint_operation_private_inputs (
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  caller_id text NOT NULL,
  operation_id text NOT NULL,
  request_key text NOT NULL,
  content_text text NOT NULL CHECK (octet_length(content_text) <= 4194304),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  PRIMARY KEY (workspace_id, harness_slug, caller_id, operation_id, request_key)
);

COMMENT ON TABLE harness_shared.blueprint_operation_private_inputs IS
  'Transient operation-scoped private input (D-014): readable only by the holder of the operation''s non-terminal work item; deleted at terminal state or expires_at by the trigger-delivery retention sweep.';

CREATE INDEX IF NOT EXISTS blueprint_operation_private_inputs_expires_idx
  ON harness_shared.blueprint_operation_private_inputs (expires_at);

ALTER TABLE harness_shared.blueprint_operation_private_inputs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS blueprint_operation_private_inputs_workspace_isolation
  ON harness_shared.blueprint_operation_private_inputs;
CREATE POLICY blueprint_operation_private_inputs_workspace_isolation
  ON harness_shared.blueprint_operation_private_inputs
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

-- Private content: no harness_zero grant, so it never enters client sync.
GRANT SELECT, INSERT, DELETE ON harness_shared.blueprint_operation_private_inputs TO harness_app;
