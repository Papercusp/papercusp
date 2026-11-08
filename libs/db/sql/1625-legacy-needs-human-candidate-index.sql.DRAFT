-- 1625 — selective candidate index for legacy needs-human reconciliation.
--
-- EI-24778703386556106 measured the exact reconcile candidate query scanning
-- 474,942 work_items rows and taking 8,663.783ms, against a 15s statement
-- timeout. A current catalog read verifies no index predicate covers the
-- payload.needsHuman marker, and EXPLAIN still chooses a Seq Scan over 474,995
-- rows. The scoped marker census found 539 rows before the routine's remaining
-- lifecycle and typed-blocker filters.
--
-- The routine already has the matching JSON predicate. This partial B-tree
-- keeps only legacy markers and preserves its ordered LIMIT scan, while leaving
-- the row-lock and typed-blocker checks in the query as the final authority.
-- Migrations run transactionally here, so CREATE INDEX CONCURRENTLY is not
-- supported; this one-time index build scans the table, then every routine tick
-- visits only the small marker cohort.
CREATE INDEX IF NOT EXISTS work_items_legacy_needs_human_candidates_idx
  ON harness_shared.work_items (
    updated_ts ASC NULLS FIRST,
    harness_slug ASC NULLS FIRST,
    feature_id ASC,
    workspace_id ASC
  )
  WHERE COALESCE(payload, '{}'::jsonb) ->> 'needsHuman' = 'true';

COMMENT ON INDEX harness_shared.work_items_legacy_needs_human_candidates_idx IS
  'Supports the ordered legacy needsHuman candidate scan; typed blocker checks remain in the routine query.';
