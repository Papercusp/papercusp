-- 1612-plan-closure-observations-by-build.sql
--
-- WI-6554700010029231: the release and staging operators share the database but
-- can run different evaluator builds at the same time. Keep one observation per
-- build so an older binary's legacy UPSERT cannot invalidate the newer reader.
-- The legacy plan_closure_observations table remains writable for old runtimes.

CREATE TABLE IF NOT EXISTS harness_shared.plan_closure_observations_by_build (
  workspace_id  text        NOT NULL,
  harness_slug  text        NOT NULL,
  plan_slug     text        NOT NULL,
  build_sha     text        NOT NULL CHECK (build_sha ~ '^[a-f0-9]{7,64}$'),
  satisfied     boolean     NOT NULL,
  code          text,
  skipped       text,
  message       text,
  rubric_id     text,
  graded_by     text,
  fingerprint   jsonb       NOT NULL CHECK (jsonb_typeof(fingerprint) = 'object'),
  observed_at   timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, harness_slug, plan_slug, build_sha)
);

ALTER TABLE harness_shared.plan_closure_observations_by_build ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_closure_observations_by_build_workspace_isolation
  ON harness_shared.plan_closure_observations_by_build;
CREATE POLICY plan_closure_observations_by_build_workspace_isolation
  ON harness_shared.plan_closure_observations_by_build FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.plan_closure_observations_by_build TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.plan_closure_observations_by_build IS
  'Canonical plan acceptance-gate verdicts keyed by evaluator build. The legacy plan_closure_observations table remains a compatibility mirror for older release runtimes.';
