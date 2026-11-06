-- Extend the audit history; completion/activation records retain their meaning.
-- FORWARD-COMPAT: the replacement kind CHECK only widens the allowed kinds.
-- The activation CHECK preserves its existing predicate for activation rows;
-- the new discovery column is nullable and its CHECK applies only to the new
-- kind. Old readers filter completion/activation and old writers remain valid.
ALTER TABLE harness_shared.plan_audits ADD COLUMN IF NOT EXISTS discovery jsonb;
ALTER TABLE harness_shared.plan_audits DROP CONSTRAINT IF EXISTS plan_audits_kind_check;
ALTER TABLE harness_shared.plan_audits ADD CONSTRAINT plan_audits_kind_check
  CHECK (audit_kind IN ('completion', 'activation', 'discovery'));
ALTER TABLE harness_shared.plan_audits DROP CONSTRAINT IF EXISTS plan_audits_activation_shape_check;
ALTER TABLE harness_shared.plan_audits ADD CONSTRAINT plan_audits_activation_shape_check
  CHECK (audit_kind <> 'activation' OR (
    jsonb_typeof(activation) = 'object'
    AND audited_plan_revision_id IS NOT NULL AND audited_plan_revision_seq > 0
    AND audited_plan_revision_seq IS NOT NULL
    AND audited_plan_content_hash ~ '^[0-9a-f]{64}$'));
ALTER TABLE harness_shared.plan_audits DROP CONSTRAINT IF EXISTS plan_audits_discovery_shape_check;
ALTER TABLE harness_shared.plan_audits ADD CONSTRAINT plan_audits_discovery_shape_check
  CHECK (audit_kind <> 'discovery' OR (
    discovery IS NOT NULL AND jsonb_typeof(discovery) = 'object'
    AND discovery->>'schemaVersion' IS NOT NULL AND discovery->>'schemaVersion' = '1'
    AND discovery->>'requestKey' IS NOT NULL
    AND audited_plan_revision_id IS NOT NULL AND audited_plan_revision_seq IS NOT NULL
    AND audited_plan_revision_seq > 0 AND audited_plan_content_hash IS NOT NULL
    AND audited_plan_content_hash ~ '^[0-9a-f]{64}$'));
COMMENT ON COLUMN harness_shared.plan_audits.discovery IS
  'Server-derived scoped discovery assessment and durable evidence identities; never implementation approval.';
