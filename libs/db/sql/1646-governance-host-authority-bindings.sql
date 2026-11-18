-- P-002: required host authorities are independent of their policy rows.
-- A binding can require a missing policy. Never infer human ownership from
-- policy authors, delegations, session wearers or historical installations.
-- FORWARD-COMPAT: additive, empty storage; no policy or ownership backfill.
CREATE TABLE IF NOT EXISTS harness_shared.governance_host_authority_bindings (
  workspace_id text NOT NULL CHECK (workspace_id <> '' AND workspace_id = btrim(workspace_id) AND workspace_id <> '*'),
  kind text NOT NULL CHECK (kind IN ('user', 'platform')),
  subject_id text NOT NULL CHECK (subject_id <> '' AND subject_id = btrim(subject_id)),
  human_owner_id text NOT NULL CHECK (human_owner_id <> '' AND human_owner_id = btrim(human_owner_id)),
  request_principal_revision text NOT NULL CHECK (request_principal_revision ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, kind, subject_id),
  CHECK (kind <> 'user' OR subject_id = human_owner_id)
);

GRANT SELECT ON harness_shared.governance_host_authority_bindings TO harness_app;
