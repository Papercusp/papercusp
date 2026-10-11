-- DAO HR P-003, SPEC-P-003-G/H: freeze both sides of every new policy change.
-- Historical rows retain NULL: their missing prior document cannot be reconstructed
-- from today's defaults without inventing audit evidence. The existing append-only
-- trigger protects these snapshots together with the rest of the audit row.
ALTER TABLE harness_shared.dao_hr_policy_audit
  ADD COLUMN IF NOT EXISTS before_settings jsonb
    CHECK (before_settings IS NULL OR jsonb_typeof(before_settings) = 'object'),
  ADD COLUMN IF NOT EXISTS after_settings jsonb
    CHECK (after_settings IS NULL OR jsonb_typeof(after_settings) = 'object');
