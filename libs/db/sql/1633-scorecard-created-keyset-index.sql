-- WI-6554700010049082: listScorecards' primary scan must walk scorecards in
-- keyset order instead of unpacking every issue payload before sorting.
--
-- The rubricRef expression index serves selective rubric lookups, and the
-- issue-created index serves the broader issue population. Neither supplies
-- the complete (workspace_id, created_at DESC, issue_id DESC) order restricted
-- to scorecards. Keep both existing indexes and add this distinct access path.
--
-- Match engineer_issues.created_at exactly: ordering by raw created_ts here
-- would not satisfy a query ordered by the view's to_timestamp expression.
-- Include every issue-family kind exposed by that view, including cleanup.
-- Do not restrict diagnostic/synthesized/retracted rows: list callers can
-- explicitly include them and still need the same ordered access path.
--
-- Before: the default 501-row primary read scanned the whole issue population,
-- with 1,773,948 shared-buffer hits and 1535.956 ms in the measured production
-- query (audit metadata/spec-quality probes omitted on both sides).
-- Recurrence guard: scorecards-superseder-plan-shape.integration.test.ts captures
-- the real listScorecards SQL and checks its primary scan and index eligibility.
-- Additive and compatible with the currently deployed query and view.
CREATE INDEX IF NOT EXISTS work_items_scorecard_created_keyset_idx
  ON harness_shared.work_items (
    workspace_id,
    (to_timestamp((created_ts::numeric / 1000.0)::double precision)) DESC,
    feature_id DESC
  )
  WHERE item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text, 'cleanup'::text])
    AND (payload -> 'observation' ->> 'rubricRef') IS NOT NULL;

COMMENT ON INDEX harness_shared.work_items_scorecard_created_keyset_idx IS
  'WI-6554700010049082: ordered partial access path for listScorecards through '
  'engineer_issues. Keep the timestamp expression, issue-family predicate and '
  'issue_id tie-breaker aligned with that view and the production keyset query.';
