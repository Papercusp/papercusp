-- Shared reference system P-009: the existing receipt-backed parts store can
-- prove that a complete reference unit reached one context epoch.
-- Legacy P-005 overflow-only rows remain deliverable but cannot prove coverage
-- (they did not record inline parts or an epoch). Expand-only.
ALTER TABLE harness_shared.work_item_unit_overflow_parts
  ADD COLUMN IF NOT EXISTS reference_key text,
  ADD COLUMN IF NOT EXISTS context_epoch integer CHECK (context_epoch >= 0);

CREATE INDEX IF NOT EXISTS work_item_unit_reference_coverage_idx
  ON harness_shared.work_item_unit_overflow_parts
    (workspace_id, owner_id, context_epoch, reference_key, unit_sha256, invocation_id)
  WHERE reference_key IS NOT NULL AND context_epoch IS NOT NULL;

COMMENT ON COLUMN harness_shared.work_item_unit_overflow_parts.reference_key IS
  'Canonical, scoped reference identity. NULL denotes a legacy overflow-only invocation, not proof of a complete unit.';
COMMENT ON COLUMN harness_shared.work_item_unit_overflow_parts.context_epoch IS
  'Recipient context epoch at preparation; only a complete same-epoch set of proven parts establishes reference coverage.';
