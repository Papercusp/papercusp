-- P-011: bounded research subjects, separate from delivered-push telemetry.
CREATE TABLE IF NOT EXISTS harness_shared.code_intel_research_trails (
  workspace_id text NOT NULL,
  owner_id text NOT NULL,
  harness_slug text NOT NULL,
  client text,
  subjects jsonb NOT NULL DEFAULT '[]'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, owner_id, harness_slug),
  CHECK (jsonb_typeof(subjects) = 'array' AND jsonb_array_length(subjects) <= 200)
);
CREATE INDEX IF NOT EXISTS code_intel_research_trails_age_idx
  ON harness_shared.code_intel_research_trails (captured_at);
ALTER TABLE harness_shared.code_intel_research_trails ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS code_intel_research_trails_workspace ON harness_shared.code_intel_research_trails;
CREATE POLICY code_intel_research_trails_workspace ON harness_shared.code_intel_research_trails
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.code_intel_research_trails TO harness_app;
COMMENT ON TABLE harness_shared.code_intel_research_trails IS
  'Local optional research subjects keyed by stable coord owner; at most 200 subjects, seven-day logical and scheduled retention. Capture does not imply a push or an accepted anchor.';

-- Extend the existing janitor without changing its cadence or active state.
UPDATE harness_shared.routines
SET trigger_config = jsonb_set(COALESCE(trigger_config, '{}'::jsonb), '{targets}',
    COALESCE(trigger_config->'targets', '[]'::jsonb) ||
      '[{"category":"code-intel-research-trails","retention_days":7}]'::jsonb),
    updated_at = now()
WHERE target_role = 'system:telemetry-retention'
  AND jsonb_typeof(trigger_config->'targets') = 'array'
  AND NOT (trigger_config->'targets' @> '[{"category":"code-intel-research-trails"}]'::jsonb);
