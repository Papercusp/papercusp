-- Migration 1506 — partial index over work items whose terminal close CITED facts
-- (plan carry-recheck-and-governed-memory-2026-10-14, P-003 / WI-6554700010012896).
--
-- WHY. P-003 cascades a fact's retraction or supersession to every closed work item whose
-- recorded completion assumptions cite that fact (payload._assumptions.declared, written by
-- coord-lifecycle/records.ts terminalPayloadMergeJson). The cascade runs from
-- agent-facts/store.ts retractFact and from assertFact's supersession branch — i.e. on every
-- re-assert of an existing fact key — so it must not scan work_items.
--
-- Measured 2026-10-14 13:33Z: 363,801 work_items rows; 47,898 carry _assumptions, but only
-- 1,139 carry an ARRAY declaration (the rest declared 'none'); no index covers the payload
-- path, and the unindexed containment scan took ~1.3s.
--
-- SHAPE. Same pattern as 1475 (work_items_external_blockers_ws_idx): a btree on workspace_id
-- restricted to the tiny cited population. The cascade's query repeats this exact predicate,
-- then applies its jsonb containment filter (@>) to the indexed rows only. The filename keeps
-- its reserved "-gin" slug; the index is a partial btree because at ~1k rows a GIN buys nothing.
--
-- Non-destructive: CREATE INDEX IF NOT EXISTS only.

CREATE INDEX IF NOT EXISTS work_items_cited_assumptions_ws_idx
  ON harness_shared.work_items
  USING btree (workspace_id)
  WHERE (jsonb_typeof((payload -> '_assumptions'::text) -> 'declared'::text) = 'array'::text);
