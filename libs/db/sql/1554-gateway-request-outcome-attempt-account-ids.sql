-- Retain the ordered route accounts for each request. A failed attempt can exit
-- before downstream.start records the account in cache-serving telemetry.
ALTER TABLE harness_shared.gateway_request_outcomes
  ADD COLUMN IF NOT EXISTS attempt_account_ids jsonb NOT NULL DEFAULT '[]'::jsonb
  CONSTRAINT gateway_request_outcomes_attempt_account_ids_check
  CHECK (jsonb_typeof(attempt_account_ids) = 'array');

COMMENT ON COLUMN harness_shared.gateway_request_outcomes.attempt_account_ids IS
  'Ordered, privacy-bounded account ids selected by request-kernel attempts.';
