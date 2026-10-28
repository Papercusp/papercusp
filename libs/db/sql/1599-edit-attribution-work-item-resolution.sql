-- 1599: record HOW an edit's work_item_id was chosen, and the candidates when none was.
--
-- Plan change-provenance-and-admission-throughput-2026-10-27 P-005 (R-4). The edit-time
-- writer (packages/operator-core/lib/edit-attribution.ts) used to read the short-lived
-- work_item_claims lease, so 1,185 of 2,167 unstamped Claude edits in 24 h came from agents
-- that DID hold a work-item per work_items.taken_by. It now resolves from taken_by and
-- stamps each row with the rule that chose the id. When an agent holds several items and
-- neither the lock nor its declared intent names one, the row keeps work_item_id NULL and
-- lists the held ids here, so a reader can tell "ambiguous" from "held nothing".
--
-- Additive only: two nullable columns, no default, no rewrite. Rows written before this
-- migration keep NULL in both (unknown resolution).

ALTER TABLE harness_shared.edit_attribution_ledger
  ADD COLUMN IF NOT EXISTS work_item_resolution text,
  ADD COLUMN IF NOT EXISTS work_item_candidates text[];

COMMENT ON COLUMN harness_shared.edit_attribution_ledger.work_item_resolution IS
  'How work_item_id was chosen at edit time: goal-ref (validated caller pointer), goal-ref-unowned (pointer not held; id left NULL), single-holder, lock-intent, declared-intent, ambiguous (several held, none named; see work_item_candidates), none (held nothing), lookup-failed, no-workspace. NULL on rows written before migration 1599.';

COMMENT ON COLUMN harness_shared.edit_attribution_ledger.work_item_candidates IS
  'The editor''s non-terminal held work-item ids (work_items.taken_by) when work_item_id could not be chosen (resolution ambiguous or goal-ref-unowned). NULL otherwise.';
