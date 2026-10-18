-- WI-6554700010008699: extend the existing outcome ledger with the identity
-- already observed in provider completions. Historical unknowns remain NULL.
ALTER TABLE harness_shared.gateway_request_outcomes
  ADD COLUMN IF NOT EXISTS provider_response_id text
  CHECK (provider_response_id IS NULL OR
    (length(provider_response_id) BETWEEN 1 AND 512 AND btrim(provider_response_id) = provider_response_id));

CREATE INDEX IF NOT EXISTS gateway_request_outcomes_response_idx
  ON harness_shared.gateway_request_outcomes (workspace_id, provider_response_id, owner_id)
  WHERE provider_response_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_usage_samples_pending_response_account_idx
  ON harness_shared.agent_usage_samples (workspace_id, id DESC)
  WHERE source = 'interactive' AND account_id IS NULL
    AND usage_provenance->>'providerResponseId' IS NOT NULL;

COMMENT ON COLUMN harness_shared.gateway_request_outcomes.provider_response_id IS
  'Exact provider completion identity, not a native turn, soft pin, account login or gateway request ordinal.';
