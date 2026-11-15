-- WI-6554700010049082: add the missing access path for the existing
-- spec-quality supersession series probe. With only primary index 1633,
-- the full production query still took 13.16s / 2.109M buffer hits:
-- per-row probes intersected the whole rubric and issue-created indexes
-- before filtering class and plan key. No existing index covers that series.
-- Match specQualitySupersederSql and engineer_issues.created_at exactly.
-- Subject syntax, different hash and sourceHive remain semantic filters.
-- Additive: existing indexes and old releases remain compatible.
CREATE INDEX IF NOT EXISTS work_items_obs_spec_quality_series_idx
  ON harness_shared.work_items (
    workspace_id,
    (split_part(payload -> 'observation' -> 'subject' ->> 'ref', ':', 2)),
    (split_part(payload -> 'observation' -> 'subject' ->> 'ref', ':', 4)),
    (to_timestamp((created_ts::numeric / 1000.0)::double precision)) DESC,
    feature_id DESC
  )
  WHERE item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text, 'cleanup'::text])
    AND payload -> 'observation' ->> 'rubricRef' = 'spec-quality'
    AND payload -> 'observation' -> 'subject' ->> 'kind' = 'plan';

COMMENT ON INDEX harness_shared.work_items_obs_spec_quality_series_idx IS
  'WI-6554700010049082: selective ordered spec-quality supersession probe by '
  'workspace, subject class and plan key. Keep expressions aligned with '
  'specQualitySupersederSql and the engineer_issues created_at expression.';
