-- 1457-dao-hr-contract-templates.sql — DAO HR contract-template registry and binding
-- gate inputs (dao-hr-people-2026-10-11 P-001, R-5; decisions D-006, D-011, D-012).
--
-- Contracts are generated ONLY from a registered template version. A version's
-- content hash covers its body and declared merge fields; a counsel approval
-- records the hash it approved, so an approval stops applying the moment the
-- version is edited (SPEC-P-001-C). Whether a generated contract may be
-- presented as binding is decided by the writer from these rows: an approval
-- whose hash matches the version AND a formed issuing entity for the DAO
-- (D-006). Everything else is stamped "Non-binding sample".
--
-- Shipped sample templates are rows with is_sample = true; they can never be
-- approved (the writer refuses, and the approval row would have no meaning).
--
-- Admin actions (template edits, approvals, the issuing-entity record) are
-- restricted to the DAO's HR admin roster below — person records (PER-), so the
-- roster is the same shared person the work profile hangs off (R-1, D-011).
--
-- NO CONTACT COLUMNS (R-1): the issuing entity's registered title is a company
-- fact, stored as registered_title; counsel is identified by approver_ref.
--
-- FORWARD-COMPAT: purely additive (five new tables + indexes + policies); nothing
-- the currently-deployed release reads changes.

-- ── HR admin roster ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_admins (
  workspace_id  text        NOT NULL,
  dao_slug      text        NOT NULL CHECK (length(btrim(dao_slug)) BETWEEN 1 AND 200),
  person_id     text        NOT NULL CHECK (person_id ~ '^PER-'),
  granted_by    text        NOT NULL CHECK (length(btrim(granted_by)) BETWEEN 1 AND 200),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, dao_slug, person_id)
);

-- ── Issuing entity (the formed company a binding contract is issued by) ──────
CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_issuing_entities (
  workspace_id           text        NOT NULL,
  dao_slug               text        NOT NULL CHECK (length(btrim(dao_slug)) BETWEEN 1 AND 200),
  registered_title       text        NOT NULL CHECK (length(btrim(registered_title)) BETWEEN 1 AND 300),
  jurisdiction           text        NOT NULL CHECK (length(btrim(jurisdiction)) BETWEEN 2 AND 64),
  registration_reference text        NOT NULL CHECK (length(btrim(registration_reference)) BETWEEN 1 AND 300),
  formed_on              date        NOT NULL,
  recorded_by            text        NOT NULL CHECK (recorded_by ~ '^PER-'),
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, dao_slug)
);

-- ── Templates: one per (document kind, engagement type, jurisdiction) ────────
CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_contract_templates (
  workspace_id    text        NOT NULL,
  dao_slug        text        NOT NULL CHECK (length(btrim(dao_slug)) BETWEEN 1 AND 200),
  template_key    text        NOT NULL CHECK (template_key ~ '^[a-z0-9][a-z0-9-]{0,119}$'),
  document_kind   text        NOT NULL CHECK (document_kind IN (
                    'employment-agreement', 'contractor-agreement', 'ip-assignment',
                    'equity-grant-agreement', 'onboarding-forms-list')),
  engagement_type text        NOT NULL CHECK (engagement_type IN ('employee', 'contractor')),
  jurisdiction    text        NOT NULL CHECK (length(btrim(jurisdiction)) BETWEEN 2 AND 64),
  title           text        NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  is_sample       boolean     NOT NULL DEFAULT false,
  created_by      text        NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 200),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, dao_slug, template_key),
  CONSTRAINT dao_hr_contract_templates_slot_uniq
    UNIQUE (workspace_id, dao_slug, document_kind, engagement_type, jurisdiction, is_sample)
);

-- ── Template versions: body + merge fields, hashed ───────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_contract_template_versions (
  workspace_id  text        NOT NULL,
  dao_slug      text        NOT NULL,
  template_key  text        NOT NULL,
  version       integer     NOT NULL CHECK (version > 0),
  body          text        NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 200000),
  merge_fields  jsonb       NOT NULL CHECK (jsonb_typeof(merge_fields) = 'array'),
  content_hash  text        NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_by    text        NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, dao_slug, template_key, version),
  FOREIGN KEY (workspace_id, dao_slug, template_key)
    REFERENCES harness_shared.dao_hr_contract_templates (workspace_id, dao_slug, template_key)
);

-- ── Counsel approvals: pinned to the content hash they approved ──────────────
CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_counsel_approvals (
  id             bigserial   PRIMARY KEY,
  workspace_id   text        NOT NULL,
  dao_slug       text        NOT NULL,
  template_key   text        NOT NULL,
  version        integer     NOT NULL,
  content_hash   text        NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- SPEC-P-001-D, enforced in the store as well as the writer.
  approver_ref   text        NOT NULL CHECK (length(btrim(approver_ref)) BETWEEN 1 AND 300),
  approved_on    date        NOT NULL,
  reference      text        NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 300),
  recorded_by    text        NOT NULL CHECK (recorded_by ~ '^PER-'),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, dao_slug, template_key, version)
    REFERENCES harness_shared.dao_hr_contract_template_versions (workspace_id, dao_slug, template_key, version)
);

CREATE INDEX IF NOT EXISTS dao_hr_counsel_approvals_version_idx
  ON harness_shared.dao_hr_counsel_approvals (workspace_id, dao_slug, template_key, version);

-- ── Workspace isolation + grants (same shape as 1456) ────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dao_hr_admins', 'dao_hr_issuing_entities', 'dao_hr_contract_templates',
                           'dao_hr_contract_template_versions', 'dao_hr_counsel_approvals'] LOOP
    EXECUTE format('ALTER TABLE harness_shared.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON harness_shared.%I', t || '_workspace_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON harness_shared.%I FOR ALL TO public '
      'USING (workspace_id = current_setting(''app.workspace_id'', true)) '
      'WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      t || '_workspace_isolation', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.%I TO harness_app, harness_admin', t);
  END LOOP;
END $$;

GRANT USAGE, SELECT ON SEQUENCE harness_shared.dao_hr_counsel_approvals_id_seq TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.dao_hr_contract_templates IS
  'DAO HR contract-template registry (dao-hr-people-2026-10-11 P-001, D-006). Writer: packages/operator-core/lib/dao-hr/contract-templates.ts.';
COMMENT ON TABLE harness_shared.dao_hr_counsel_approvals IS
  'Counsel approval of one template version, pinned to the content_hash it approved; an approval applies only while the version still has that hash (SPEC-P-001-C).';
COMMENT ON TABLE harness_shared.dao_hr_issuing_entities IS
  'The formed company a DAO issues binding contracts from (D-006). No row = no formed entity = every contract is stamped Non-binding sample.';
COMMENT ON TABLE harness_shared.dao_hr_admins IS
  'DAO HR admin roster: person records allowed to edit templates, record counsel approvals and the issuing entity (D-012).';
