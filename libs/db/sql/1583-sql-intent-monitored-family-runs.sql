-- P013 extends the existing census. Daily SQL history cannot represent five per-workflow family outcomes.
CREATE TABLE IF NOT EXISTS harness_shared.sql_intent_runs (
  workspace_id text NOT NULL, run_id uuid NOT NULL, scope_id text NOT NULL, harness_slug text NOT NULL,
  routine_id text, workflow_id text, source_sha text, runtime_id text NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz,
  PRIMARY KEY (workspace_id,run_id), UNIQUE (workspace_id,workflow_id),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE TABLE IF NOT EXISTS harness_shared.sql_intent_family_runs (
  workspace_id text NOT NULL, run_id uuid NOT NULL, family text NOT NULL
    CHECK (family IN ('sql','search-reformulation','result-recovery','workaround-funnel','native-operation')),
  coverage text NOT NULL CHECK (coverage IN ('measured','missing','unsupported','truncated','UNKNOWN')),
  scanned integer NOT NULL CHECK (scanned >= 0), qualifying integer NOT NULL CHECK (qualifying >= 0),
  diagnostics jsonb NOT NULL, PRIMARY KEY (workspace_id,run_id,family),
  FOREIGN KEY (workspace_id,run_id) REFERENCES harness_shared.sql_intent_runs(workspace_id,run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sql_intent_runs_retention_idx ON harness_shared.sql_intent_runs (started_at);
ALTER TABLE harness_shared.sql_intent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.sql_intent_family_runs ENABLE ROW LEVEL SECURITY;
DO $rls$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['sql_intent_runs','sql_intent_family_runs'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='harness_shared'
      AND tablename=tab AND policyname='workspace_isolation') THEN
      EXECUTE format('CREATE POLICY workspace_isolation ON harness_shared.%I
        USING (workspace_id=current_setting(''app.workspace_id'',true))
        WITH CHECK (workspace_id=current_setting(''app.workspace_id'',true))',tab);
    END IF;
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON harness_shared.%I TO harness_app',tab);
  END LOOP;
END $rls$;
