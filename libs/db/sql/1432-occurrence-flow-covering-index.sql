-- EI-25503081061868211 / P-022: the exact occurrence census needs no evidence
-- envelopes, but the old flow index forced one heap visit per report to read
-- the cluster identity and report kind. Extend that same index, preserving its
-- workspace/time key for both harness-scoped and workspace-wide readers.
-- Build the replacement before retiring the old index. The migration runner
-- executes this block transactionally; no rows or occurrence semantics change.
-- FORWARD-COMPAT: deployed readers use ordinary SELECTs and no index-name hints;
-- this non-unique index is not an ON CONFLICT arbiter. Its existing key and final
-- name survive the atomic replacement, and INCLUDE only adds census coverage.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'harness_shared'
       AND indexname = 'work_item_occurrences_flow_idx'
       AND indexdef LIKE '%INCLUDE (canonical_harness_slug, canonical_work_item_id, report_kind)%'
  ) THEN
    CREATE INDEX IF NOT EXISTS work_item_occurrences_flow_covering_idx
      ON harness_shared.work_item_occurrences (workspace_id, occurred_at DESC)
      INCLUDE (canonical_harness_slug, canonical_work_item_id, report_kind);
    DROP INDEX IF EXISTS harness_shared.work_item_occurrences_flow_idx;
    ALTER INDEX harness_shared.work_item_occurrences_flow_covering_idx
      RENAME TO work_item_occurrences_flow_idx;
  END IF;
END $$;
