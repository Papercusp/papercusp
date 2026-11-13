-- Migration 1631 — supersedes-leading probe index for listScorecards
-- (EI-28715010811839096; recurrence of EI-26502753767803422 / EI-27071469444040047).
--
-- SYMPTOM. Every grading-integrity audit emit, and scorecards:list
-- { rubricRef:'grading-integrity' }, was cancelled with SQLSTATE 57014. A judge
-- could not settle the audit of EI-28714607818941444 on four attempts, so
-- plans:start for stuck-work-detection-and-honest-waits-2026-11-13 stayed refused.
--
-- MEASURED on the live box, 2026-11-13 ~23:30Z. Statement taken verbatim from the
-- postgres log (the judge's cancelled call at 18:27:18 EST, parameters
-- workspace / 'grading-integrity' / sourceHive 'papercusp' / LIMIT 1). Read-only
-- EXPLAIN (ANALYZE, BUFFERS), uncontended:
--
--   Nested Loop Anti Join  (actual rows=8851)
--     -> Index Scan using work_items_obs_rubric_ref_v2_idx  (actual rows=8930)
--     -> Bitmap Heap Scan  (loops=8930)
--          -> BitmapAnd  (loops=8930)
--               -> Bitmap Index Scan on work_items_obs_rubric_ref_v2_idx
--                    (actual rows=9470 loops=8930)
--               -> Bitmap Index Scan on work_items_obs_supersedes_v2_idx
--                    (actual rows=0.01 loops=8930)
--   Execution Time: 8,411 ms
--
-- WHY. The NOT EXISTS superseder probe compares superseder.rubricRef with
-- scorecard.rubricRef, and the outer query pins scorecard.rubricRef to a constant.
-- The planner puts both in one equivalence class and derives
-- superseder.rubricRef = 'grading-integrity' as an inner index condition. That
-- makes it BitmapAnd the rubricRef index with the supersedes index on EVERY outer
-- row, rebuilding a bitmap of the whole rubric (9,470 TIDs) each time: O(n^2) in
-- the size of one rubric. Migration 1103 chose BitmapAnd on purpose and measured
-- it at 0.008 ms per loop when the largest rubric had 269 rows. Grading-integrity
-- now has 9,470 rows, so the same plan costs ~0.9 ms per loop.
--
-- WHAT THIS ADDS. A composite partial index whose FIRST column is supersedes. A
-- probe with both conditions becomes one index descent, costing the same however
-- large the rubric grows. The same statement with only the supersedes condition
-- driving the probe (staging's `IS TRUE` rewrite, WI-6554700010018130, which the
-- release build d740fc3802 does not have) measured 861 ms, of which the inner side
-- is 19,267 buffers over 8,930 loops. This index gives the release build that
-- access path without a code change.
--
-- WHY NOT CHANGE THE 1103 INDEXES. 1103's header measured that ADDING columns to
-- them, or leading with workspace_id, stops the BitmapAnd and costs 25x on the
-- small-rubric shape. Both stay exactly as they are; this is an extra access path
-- the planner can take when it is cheaper. supersedes leads because it is the
-- selective column (≈0.01 matches per probe); rubricRef second lets the derived
-- equality become an index condition instead of a recheck.
--
-- PARTIAL on the same predicate as work_items_obs_supersedes_v2_idx, so only
-- superseding cards are indexed and the index stays small. The probe's equality
-- on supersedes implies IS NOT NULL, so the planner can use it.
--
-- EXPAND-ONLY: adds an index, drops nothing; the live release keeps working
-- unchanged and simply gains a cheaper plan.

CREATE INDEX IF NOT EXISTS work_items_obs_supersedes_rubric_probe_idx
  ON harness_shared.work_items (
    (((payload -> 'observation') ->> 'supersedes')),
    (((payload -> 'observation') ->> 'rubricRef'))
  )
  WHERE (((payload -> 'observation') ->> 'supersedes') IS NOT NULL);

COMMENT ON INDEX harness_shared.work_items_obs_supersedes_rubric_probe_idx IS
  'EI-28715010811839096: supersedes-leading access path for listScorecards'' per-row '
  'superseder probe (packages/operator-core/lib/scorecards.ts). Without it the planner '
  'BitmapAnds work_items_obs_rubric_ref_v2_idx with work_items_obs_supersedes_v2_idx on '
  'every outer row, which is O(rubric size) per row and timed out (pg 57014) once '
  'grading-integrity reached ~9,500 cards (8.4 s measured 2026-11-13). Keep supersedes '
  'FIRST. The expressions must keep matching the engineer_issues view''s payload column, '
  'exactly like the two 1103 indexes it complements.';

ANALYZE harness_shared.work_items;
