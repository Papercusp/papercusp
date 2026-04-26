-- Framework-level shared tables for the Papercusp harness storage system.
-- Lives in `harness_shared`. Idempotent — safe to re-run.
--
-- A fresh Papercusp install only needs this. Demo installs (e.g. Papercup-org)
-- additionally run 003-papercup-shared.sql to create their cross-dept message
-- bus tables in the separate `papercup_shared` schema.

CREATE SCHEMA IF NOT EXISTS harness_shared;

-- Generic audit trail for any harness action (feature edits, role hooks, etc.).
CREATE TABLE IF NOT EXISTS harness_shared.audit_log (
  id TEXT PRIMARY KEY,
  ts BIGINT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  details JSONB
);
CREATE INDEX IF NOT EXISTS audit_ts_idx      ON harness_shared.audit_log(ts);
CREATE INDEX IF NOT EXISTS audit_action_idx  ON harness_shared.audit_log(action);
CREATE INDEX IF NOT EXISTS audit_subject_idx ON harness_shared.audit_log(subject);

-- Project registry. Some columns (owning_dept, vertical) are convenience
-- fields used by org-style demos; framework code treats them as optional.
CREATE TABLE IF NOT EXISTS harness_shared.projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  budget_cents BIGINT,
  spent_cents BIGINT NOT NULL DEFAULT 0,
  owning_dept TEXT,
  vertical TEXT,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL,
  metadata JSONB
);
CREATE INDEX IF NOT EXISTS projects_status_idx ON harness_shared.projects(status);

GRANT USAGE ON SCHEMA harness_shared TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA harness_shared TO harness_app, harness_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA harness_shared
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO harness_app, harness_admin;
