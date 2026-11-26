-- Multiple issues can name the same symptom. The reader must detect that ambiguity.
-- A legacy issue enters this index only when a complete, scoped capture installs its primary.
CREATE INDEX IF NOT EXISTS work_items_known_issue_primary_v1_idx
  ON harness_shared.work_items
     (workspace_id, harness_slug, ((payload->'knownIssuePrimaryV1')->>'key'))
  WHERE ((payload->'knownIssuePrimaryV1')->>'key') IS NOT NULL;
