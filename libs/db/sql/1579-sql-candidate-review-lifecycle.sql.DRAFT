-- Opaque identity tombstones prevent unchanged declined candidates from refiling.
-- No source SQL, examples, actor identities or demand counts are retained here.
CREATE TABLE IF NOT EXISTS harness_shared.sql_candidate_reviews (
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  lifecycle_id text NOT NULL,
  edition_id text NOT NULL,
  artifact_id text NOT NULL,
  suppressed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, lifecycle_id, edition_id),
  UNIQUE (workspace_id, artifact_id)
);
ALTER TABLE harness_shared.sql_candidate_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON harness_shared.sql_candidate_reviews
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.sql_candidate_reviews TO harness_app;
