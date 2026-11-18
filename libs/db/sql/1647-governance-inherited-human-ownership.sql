-- P-002: reuse explicit host enrollment for the inherited authority chain.
-- FORWARD-COMPAT: additive accepted kinds only. No owner/policy backfill, no
-- change to existing ownership receipts or application-role write privileges.
ALTER TABLE harness_shared.governance_host_authority_bindings
  DROP CONSTRAINT IF EXISTS governance_host_authority_bindings_kind_check;
ALTER TABLE harness_shared.governance_host_authority_bindings
  ADD CONSTRAINT governance_host_authority_bindings_kind_check
  CHECK (kind IN ('user', 'platform', 'organization', 'department', 'workspace'));
