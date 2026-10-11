-- dao-hr-people-2026-10-11 P-003 (R-2, D-001, D-004, D-013): versioned equity + hiring policy.
--
-- dao_hr_policy_versions holds one row per SAVED policy version of a DAO. A change never edits a
-- row: it inserts version N+1, so every earlier version stays readable (SPEC-P-003-F) and a policy
-- change cannot rewrite the terms anything was issued under (SPEC-P-003-A). The settings document
-- has no field that controls who can see equity or pay terms: D-001 fixes visibility for everyone
-- (SPEC-P-003-D). Personal data stays on the shared person record (D-011): only PER- ids appear here.
--
-- dao_hr_policy_audit holds one row per policy change naming the acting admin (SPEC-P-003-C), the
-- changed fields, and the admin-class contract calls that carry chain-enforced values on chain
-- without a governance proposal (SPEC-P-003-E, D-004/D-013).

CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_policy_versions (
  workspace_id  text        NOT NULL CHECK (length(btrim(workspace_id)) BETWEEN 1 AND 200),
  dao_slug      text        NOT NULL CHECK (length(btrim(dao_slug)) BETWEEN 1 AND 200),
  version       integer     NOT NULL CHECK (version >= 1),
  settings      jsonb       NOT NULL CHECK (jsonb_typeof(settings) = 'object'),
  created_by    text        NOT NULL CHECK (created_by ~ '^PER-'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, dao_slug, version)
);

CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_policy_audit (
  id               bigserial   PRIMARY KEY,
  workspace_id     text        NOT NULL,
  dao_slug         text        NOT NULL,
  version          integer     NOT NULL,
  actor_person_id  text        NOT NULL CHECK (actor_person_id ~ '^PER-'),
  changed_fields   text[]      NOT NULL CHECK (cardinality(changed_fields) >= 1),
  chain_calls      jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(chain_calls) = 'array'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, dao_slug, version)
    REFERENCES harness_shared.dao_hr_policy_versions (workspace_id, dao_slug, version)
);

CREATE INDEX IF NOT EXISTS dao_hr_policy_audit_dao_idx
  ON harness_shared.dao_hr_policy_audit (workspace_id, dao_slug, created_at DESC);

-- Both tables are append-only: a saved version and its audit row are history, never edited.
-- (DELETE stays possible so a workspace purge can remove a DAO's rows wholesale.)
CREATE OR REPLACE FUNCTION harness_shared.dao_hr_policy_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dao_hr policy versions and audit rows are append-only (% on %)', TG_OP, TG_TABLE_NAME;
END
$$;

CREATE OR REPLACE TRIGGER dao_hr_policy_versions_append_only
  BEFORE UPDATE ON harness_shared.dao_hr_policy_versions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.dao_hr_policy_append_only();

CREATE OR REPLACE TRIGGER dao_hr_policy_audit_append_only
  BEFORE UPDATE ON harness_shared.dao_hr_policy_audit
  FOR EACH ROW EXECUTE FUNCTION harness_shared.dao_hr_policy_append_only();
