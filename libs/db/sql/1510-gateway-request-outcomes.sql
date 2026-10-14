-- WI-6554700010013274: retain privacy-bounded gateway request outcomes beyond
-- process restarts. Bodies, credentials, headers and raw provider errors are
-- deliberately excluded; request identity includes the gateway process UUID
-- because each process-local request ordinal restarts at one.

CREATE TABLE IF NOT EXISTS harness_shared.gateway_request_outcomes (
  request_id text NOT NULL,
  workspace_id text NOT NULL,
  gateway_process_instance_id uuid NOT NULL,
  request_ordinal bigint NOT NULL CHECK (request_ordinal > 0),
  owner_id text,
  provider text NOT NULL CHECK (provider IN ('claude', 'codex', 'local')),
  protocol text NOT NULL CHECK (protocol IN ('anthropic-messages', 'openai-responses', 'unknown')),
  transport text NOT NULL CHECK (transport IN ('bearer-http', 'oauth-http', 'cli-exec', 'local-http', 'unknown')),
  model text,
  selected_account_id text,
  outcome_class text NOT NULL CHECK (outcome_class IN (
    'ok', 'client-error', 'upstream-429', 'upstream-error', 'shed', 'cancelled', 'gateway-error', 'unclassified'
  )),
  final_status integer CHECK (final_status IS NULL OR final_status BETWEEN 100 AND 599),
  request_timestamp_ms bigint NOT NULL CHECK (request_timestamp_ms >= 0),
  finalized_at_ms bigint NOT NULL CHECK (finalized_at_ms >= request_timestamp_ms),
  attempts integer NOT NULL CHECK (attempts >= 0),
  failovers integer NOT NULL CHECK (failovers >= 0),
  native_session_id text,
  native_thread_id text,
  native_turn_id text,
  native_window_id text,
  recorded_at_ms bigint NOT NULL CHECK (recorded_at_ms >= 0),
  retention_expires_at_ms bigint NOT NULL CHECK (retention_expires_at_ms > recorded_at_ms),
  PRIMARY KEY (gateway_process_instance_id, request_ordinal),
  UNIQUE (workspace_id, request_id)
);

CREATE INDEX IF NOT EXISTS gateway_request_outcomes_owner_time_idx
  ON harness_shared.gateway_request_outcomes (workspace_id, owner_id, request_timestamp_ms, request_ordinal);
CREATE INDEX IF NOT EXISTS gateway_request_outcomes_retention_idx
  ON harness_shared.gateway_request_outcomes (workspace_id, retention_expires_at_ms);

ALTER TABLE harness_shared.gateway_request_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gateway_request_outcomes_workspace_isolation ON harness_shared.gateway_request_outcomes;
CREATE POLICY gateway_request_outcomes_workspace_isolation
  ON harness_shared.gateway_request_outcomes
  FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, DELETE ON harness_shared.gateway_request_outcomes TO harness_app;
GRANT SELECT ON harness_shared.gateway_request_outcomes TO harness_zero;

COMMENT ON TABLE harness_shared.gateway_request_outcomes IS
  'Fourteen-day, privacy-bounded per-request gateway route/outcome evidence. Request bodies, headers, credentials and raw errors are never stored.';
