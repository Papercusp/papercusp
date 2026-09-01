-- 1063-attention-bulk-item-reversal-window.sql
--
-- P-010: an unattended Inbox bulk action is only trustworthy after the fact if
-- the owner can undo the exact item for a bounded period.  Persist the
-- compensation handle on the immutable per-item audit row; a successful undo
-- records compensation metadata instead of rewriting the original decision.
--
-- Historical auto_resolved rows predate this contract and cannot be assigned a
-- truthful executable handle after the fact.  The NOT VALID constraint keeps
-- those rows readable while PostgreSQL enforces the invariant for every new or
-- subsequently updated auto_resolved row.

ALTER TABLE harness_shared.attention_bulk_run_items
  ADD COLUMN IF NOT EXISTS revert_handle JSONB,
  ADD COLUMN IF NOT EXISTS reversal_window_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revert_note TEXT;

COMMENT ON COLUMN harness_shared.attention_bulk_run_items.revert_handle IS
  'Typed autonomy revert-executor handle for the exact terminal action. Required '
  'for newly written auto_resolved rows; historical rows remain NULL rather than '
  'claiming a compensation path that never existed.';

COMMENT ON COLUMN harness_shared.attention_bulk_run_items.reversal_window_until IS
  'Exclusive owner undo deadline for this item. It must be later than decided_at '
  'for every newly written auto_resolved row.';

COMMENT ON COLUMN harness_shared.attention_bulk_run_items.reverted_at IS
  'When compensation completed successfully. The original action/outcome audit '
  'is immutable; undo is represented by this timestamp plus revert_note.';

COMMENT ON COLUMN harness_shared.attention_bulk_run_items.revert_note IS
  'Non-empty compensation result recorded when reverted_at is set.';

ALTER TABLE harness_shared.attention_bulk_run_items
  DROP CONSTRAINT IF EXISTS attention_bulk_run_items_auto_resolved_reversal_check;

ALTER TABLE harness_shared.attention_bulk_run_items
  ADD CONSTRAINT attention_bulk_run_items_auto_resolved_reversal_check
  CHECK (
    outcome <> 'auto_resolved'
    OR (
      revert_handle IS NOT NULL
      AND jsonb_typeof(revert_handle) = 'object'
      AND COALESCE(NULLIF(btrim(revert_handle ->> 'kind'), ''), '') <> ''
      AND decided_at IS NOT NULL
      AND reversal_window_until IS NOT NULL
      AND reversal_window_until > decided_at
    )
  ) NOT VALID;

ALTER TABLE harness_shared.attention_bulk_run_items
  DROP CONSTRAINT IF EXISTS attention_bulk_run_items_compensation_record_check;

ALTER TABLE harness_shared.attention_bulk_run_items
  ADD CONSTRAINT attention_bulk_run_items_compensation_record_check
  CHECK (
    (reverted_at IS NULL AND revert_note IS NULL)
    OR (
      reverted_at IS NOT NULL
      AND revert_handle IS NOT NULL
      AND COALESCE(NULLIF(btrim(revert_note), ''), '') <> ''
    )
  );

CREATE INDEX IF NOT EXISTS attention_bulk_run_items_open_reversal_idx
  ON harness_shared.attention_bulk_run_items
    (workspace_id, reversal_window_until, run_id, position)
  WHERE outcome = 'auto_resolved' AND reverted_at IS NULL;
