-- 1630: keep planner statistics fresh for the append-mostly recipe receipt ledger.
--
-- EI-27754954412452272 measured 46,579 modifications since analyze against the
-- default trigger of roughly 47,987 (50 + 0.1 * 479,366). The timestamp histogram
-- ended on 2026-10-27; for a fixed one-day window the literal plan estimated one
-- row while the matching count returned 4,340. The default analyze threshold was
-- therefore just high enough to leave recent receipt data invisible to the planner.
--
-- Use the existing high-churn telemetry policy (migration 320): analyze after a
-- smaller absolute-plus-relative change count. This only adjusts per-table
-- reloptions; it does not change indexes, vacuum policy, or stored data.

ALTER TABLE IF EXISTS harness_shared.code_recipe_runs
  SET (autovacuum_analyze_scale_factor = 0.02,
       autovacuum_analyze_threshold = 10000);
