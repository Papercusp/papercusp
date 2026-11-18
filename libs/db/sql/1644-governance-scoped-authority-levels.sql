-- P-002: independent user/platform authorities reuse governance policy rows
-- and their complete version ledger. They never join the inherited org chain.
-- FORWARD-COMPAT: both replacement CHECKs admit every formerly valid row and
-- every legacy organization/department/workspace write. No rows are inserted
-- or rewritten; independent policies are authored only by the new storage seam.
ALTER TABLE harness_shared.governance_policy_layers
  DROP CONSTRAINT IF EXISTS governance_policy_layers_level_check;
ALTER TABLE harness_shared.governance_policy_layers
  ADD CONSTRAINT governance_policy_layers_level_check
  CHECK (level IN ('organization', 'department', 'workspace', 'user', 'platform'));
ALTER TABLE harness_shared.governance_policy_layers
  DROP CONSTRAINT IF EXISTS governance_policy_layers_root_is_org;
ALTER TABLE harness_shared.governance_policy_layers
  ADD CONSTRAINT governance_policy_layers_root_is_org
  CHECK ((parent_layer_id IS NULL) = (level IN ('organization', 'user', 'platform')));
