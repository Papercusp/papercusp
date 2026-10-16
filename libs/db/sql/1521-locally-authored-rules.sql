-- Locally authored portable rules. Additive; installed packages remain inert.
CREATE TABLE IF NOT EXISTS harness_shared.local_rules (
  workspace_id text NOT NULL,
  pot_slug text NOT NULL DEFAULT '',
  rule_id text NOT NULL,
  author_id text NOT NULL,
  definition jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  tested_revision integer,
  test_receipt jsonb,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, pot_slug, rule_id),
  CHECK (jsonb_typeof(definition) = 'object'),
  CHECK (tested_revision IS NULL OR tested_revision = revision),
  CHECK (NOT enabled OR (tested_revision IS NOT NULL AND tested_revision = revision AND test_receipt IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS local_rules_enabled_scope_idx
  ON harness_shared.local_rules (workspace_id, pot_slug, enabled);

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.local_rules TO harness_app;
ALTER TABLE harness_shared.local_rules ENABLE ROW LEVEL SECURITY;
DO $policy$ BEGIN
  CREATE POLICY local_rules_workspace_isolation ON harness_shared.local_rules
    FOR ALL
    USING (workspace_id = current_setting('app.workspace_id', true))
    WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
EXCEPTION WHEN duplicate_object THEN NULL;
END $policy$;
