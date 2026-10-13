-- Extend the maintained spawn/request telemetry; no second routing ledger.
ALTER TABLE harness_shared.spawned_agents
  ADD COLUMN IF NOT EXISTS account_route jsonb,
  ADD COLUMN IF NOT EXISTS first_gateway_request jsonb;
