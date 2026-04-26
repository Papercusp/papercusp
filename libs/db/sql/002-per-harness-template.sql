-- Per-harness tables. Replace {{SCHEMA}} with harness_<slug_with_underscores>.
-- Idempotent — safe to re-run.

CREATE SCHEMA IF NOT EXISTS {{SCHEMA}};

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.harness_features (
  harness_slug TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,
  attempts BIGINT NOT NULL DEFAULT 0,
  claims TEXT,
  notes TEXT,
  metadata JSONB,
  kind TEXT,
  project_id TEXT,
  expected_cost_cents BIGINT,
  tags JSONB,
  needs_human_review BOOLEAN NOT NULL DEFAULT FALSE,
  ts BIGINT,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL,
  -- Goal-ancestry: parent feature + top-level goal (cross-schema FK).
  parent_id TEXT,
  goal_id TEXT,
  -- Atomic checkout (FOR UPDATE SKIP LOCKED idiom).
  taken_by TEXT,
  taken_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (harness_slug, feature_id)
);
CREATE INDEX IF NOT EXISTS hf_status_idx  ON {{SCHEMA}}.harness_features(harness_slug, status);
CREATE INDEX IF NOT EXISTS hf_project_idx ON {{SCHEMA}}.harness_features(project_id);
CREATE INDEX IF NOT EXISTS hf_review_idx  ON {{SCHEMA}}.harness_features(needs_human_review);
CREATE INDEX IF NOT EXISTS hf_goal_idx    ON {{SCHEMA}}.harness_features(goal_id);
CREATE INDEX IF NOT EXISTS hf_parent_idx  ON {{SCHEMA}}.harness_features(harness_slug, parent_id);
CREATE INDEX IF NOT EXISTS hf_available_idx
  ON {{SCHEMA}}.harness_features(harness_slug, status)
  WHERE taken_by IS NULL;
CREATE INDEX IF NOT EXISTS hf_expires_idx
  ON {{SCHEMA}}.harness_features(expires_at)
  WHERE taken_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.feature_audit (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
  harness_slug TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor TEXT
);
CREATE INDEX IF NOT EXISTS fa_ts_idx      ON {{SCHEMA}}.feature_audit(ts);
CREATE INDEX IF NOT EXISTS fa_feature_idx ON {{SCHEMA}}.feature_audit(harness_slug, feature_id);

GRANT USAGE ON SCHEMA {{SCHEMA}} TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {{SCHEMA}} TO harness_app, harness_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA {{SCHEMA}} TO harness_app, harness_admin;
