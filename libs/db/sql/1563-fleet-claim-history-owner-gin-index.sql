-- 1563 — narrow fleet claim-history expansion to ever-member owners.
--
-- WI-6554700010021982 measured a full-workspace worked_by_history expansion at
-- 416,035 work-item rows / 38,880 history entries / 95,758 shared-buffer hits
-- and 3,040ms for the aggregate; the bounded recent-history read took 488ms.
-- fleet:leader-brief and fleet:audit now apply JSONB owner containment before
-- jsonb_array_elements, then retain the exact owner and time predicates.
--
-- The migration runner wraps each file in a transaction, so this uses ordinary
-- CREATE INDEX. For a large live table, pre-build this exact definition with
-- CREATE INDEX CONCURRENTLY before applying; IF NOT EXISTS makes that apply a
-- no-op after the online build.

CREATE INDEX IF NOT EXISTS work_items_worked_by_history_owner_gin_idx
  ON harness_shared.work_items
  USING gin (worked_by_history jsonb_path_ops)
  WHERE jsonb_typeof(worked_by_history) = 'array'
    AND worked_by_history <> '[]'::jsonb;

COMMENT ON INDEX harness_shared.work_items_worked_by_history_owner_gin_idx IS
  'fleet campaign and audit: owner containment before worked_by_history array expansion';
