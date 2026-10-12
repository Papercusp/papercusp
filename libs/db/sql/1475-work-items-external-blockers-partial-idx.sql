-- Migration 1475 — partial index over work items that carry typed external blockers
-- (plan derived-status-not-hand-written-2026-10-12#P-011).
--
-- WHY. Two system paths look up "which work items carry a blocker matching X" on a
-- trigger, inside a transaction, with `FOR UPDATE`:
--   * reconcileEventExternalBlockers (work-items.ts) — on every announced-event
--     settlement, matches `payload @> {externalBlockers:[{kind:'event',ref,status:'active'}]}`;
--   * the work-item-ref blocker auto-clear (work-item-ref-blocker-auto-clear.ts, P-011) —
--     on every terminal work-item transition, matches active blockers whose ref names
--     the finished item.
-- harness_shared.work_items has no GIN index on payload, so both read the whole table.
-- MEASURED 2026-10-12 on papercusp-workspace (354,731 rows, 3,666 carrying the
-- `externalBlockers` key): the auto-clear prefilter ran as a Seq Scan, 2,801 ms,
-- 790,849 shared buffers, 355,189 rows removed by filter, to return one row.
--
-- WHAT. A btree on workspace_id, partial on `payload ? 'externalBlockers'`. Both
-- queries now carry that exact predicate, so the planner can prove the implication and
-- read only the ~1% of rows that have ever carried a blocker. Cleared blockers stay in
-- the payload as history, so the partial set only grows with rows that were ever
-- blocked — not with the table.
--
-- Additive only: no DROP, no rename, no constraint. The currently-deployed release does
-- not reference the index and keeps working unchanged against it.
CREATE INDEX IF NOT EXISTS work_items_external_blockers_ws_idx
  ON harness_shared.work_items
  USING btree (workspace_id)
  WHERE (payload ? 'externalBlockers');
