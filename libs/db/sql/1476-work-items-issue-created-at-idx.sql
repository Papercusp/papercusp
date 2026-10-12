-- Migration 1476 — index the issue family's created_at ordering
-- (plan papercusp-performance-audit-2026-10-12, P-004).
--
-- WHY. listIssuesWithLimit (packages/operator-core/lib/issues-engineer.ts) ends every
-- limited read with `ORDER BY created_at DESC LIMIT n` against the engineer_issues
-- view. The view computes
--   created_at = to_timestamp((created_ts::numeric / 1000.0)::double precision)
-- and no index on work_items carries that expression, so Postgres cannot read rows
-- in order and stop early. It parallel-seq-scans every work_items row, keeps the
-- issue family, and top-N sorts it.
--
-- MEASURED on the live box 2026-10-12 (pg_stat_statements queryid 8284623565653007678):
-- 132,492 calls at 1,023 ms mean (~37.6 h of execution since the stats reset),
-- 299 rows per call. EXPLAIN (ANALYZE, BUFFERS) of a representative instance
-- (workspace papercusp-workspace, kinds bug/change/task, observation lane excluded,
-- top-level only, LIMIT 300) on a quiet host:
--
--   before   Parallel Seq Scan + top-N Sort   535 ms   588,900 buffers
--   after    Index Scan on this index + Limit   7.3 ms     3,536 buffers
--
-- and the open-issues variant (kinds bug/change, state='open', LIMIT 300): 0.8 ms,
-- 381 buffers. Both measured by building this exact index inside a rolled-back
-- transaction; the build took 929 ms.
--
-- SHAPE. Leading workspace_id serves the view's tenant filter; the expression is
-- byte-identical to the view's created_at so the planner matches it through view
-- inlining; DESC matches the read order. The partial predicate is the view's own
-- WHERE clause (item_kind = ANY(bug, change, task)), so every engineer_issues read
-- satisfies it and the index stays a third the size of an unconditional one.
-- to_timestamp(double precision), the numeric division and the casts are all
-- IMMUTABLE, so the expression is indexable.
--
-- LOCKING. A plain (non-CONCURRENT) build: the runner wraps each file in a
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one (same trade-off as
-- migrations 753 and 792). It holds a ShareLock on work_items for the build, blocking
-- writes for about one second (929 ms measured above).
--
-- FORWARD-COMPAT. Additive only: no existing index, column or view changes, so the
-- currently-deployed release keeps working and simply gets the faster plan.
CREATE INDEX IF NOT EXISTS work_items_issue_created_at_idx
  ON harness_shared.work_items (
    workspace_id,
    (to_timestamp(((created_ts)::numeric / 1000.0)::double precision)) DESC
  )
  WHERE item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text]);
