-- P005: hiring facts reference shared PER records; no names, email or contact copies.
CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_roles (
  workspace_id text NOT NULL, dao_slug text NOT NULL, role_id text NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  level text NOT NULL CHECK (length(btrim(level)) BETWEEN 1 AND 60),
  manager_person_id text CHECK (manager_person_id ~ '^PER-'),
  exclusive boolean NOT NULL DEFAULT false,
  created_by text NOT NULL CHECK (created_by ~ '^PER-'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, dao_slug, role_id)
);
CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_candidates (
  workspace_id text NOT NULL, dao_slug text NOT NULL, role_id text NOT NULL,
  person_id text NOT NULL CHECK (person_id ~ '^PER-'),
  created_by text NOT NULL CHECK (created_by ~ '^PER-'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, dao_slug, role_id, person_id),
  FOREIGN KEY (workspace_id, dao_slug, role_id) REFERENCES harness_shared.dao_hr_roles
);
CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_offers (
  workspace_id text NOT NULL, dao_slug text NOT NULL, offer_id text NOT NULL,
  role_id text NOT NULL, person_id text NOT NULL CHECK (person_id ~ '^PER-'),
  authored_by text NOT NULL CHECK (authored_by ~ '^PER-'),
  terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
  approvals_required integer NOT NULL CHECK (approvals_required BETWEEN 1 AND 10),
  state text NOT NULL DEFAULT 'offered' CHECK (state IN ('offered','approved','contract-generated','signed','hire-proposed','hired','rejected','lapsed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, dao_slug, offer_id),
  FOREIGN KEY (workspace_id, dao_slug, role_id, person_id) REFERENCES harness_shared.dao_hr_candidates
);
CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_offer_approvals (
  workspace_id text NOT NULL, dao_slug text NOT NULL, offer_id text NOT NULL,
  actor_person_id text NOT NULL CHECK (actor_person_id ~ '^PER-'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, dao_slug, offer_id, actor_person_id),
  FOREIGN KEY (workspace_id, dao_slug, offer_id) REFERENCES harness_shared.dao_hr_offers
);
CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_hiring_history (
  id bigserial PRIMARY KEY, workspace_id text NOT NULL, dao_slug text NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('role','candidate','offer')),
  subject_id text NOT NULL, state text NOT NULL,
  actor_person_id text NOT NULL CHECK (actor_person_id ~ '^PER-'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dao_hr_hiring_history_subject_idx ON harness_shared.dao_hr_hiring_history (workspace_id,dao_slug,subject_kind,subject_id,id);
-- Terms are immutable; subsequent policy changes cannot rewrite an existing offer.
CREATE OR REPLACE FUNCTION harness_shared.dao_hr_offer_immutable_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.dao_slug IS DISTINCT FROM OLD.dao_slug
     OR NEW.offer_id IS DISTINCT FROM OLD.offer_id OR NEW.role_id IS DISTINCT FROM OLD.role_id
     OR NEW.person_id IS DISTINCT FROM OLD.person_id OR NEW.authored_by IS DISTINCT FROM OLD.authored_by
     OR NEW.terms IS DISTINCT FROM OLD.terms OR NEW.approvals_required IS DISTINCT FROM OLD.approvals_required THEN
    RAISE EXCEPTION 'dao_hr offer terms are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER dao_hr_offer_immutable_terms BEFORE UPDATE ON harness_shared.dao_hr_offers
  FOR EACH ROW EXECUTE FUNCTION harness_shared.dao_hr_offer_immutable_terms();
CREATE OR REPLACE TRIGGER dao_hr_offer_approvals_append_only BEFORE UPDATE ON harness_shared.dao_hr_offer_approvals
  FOR EACH ROW EXECUTE FUNCTION harness_shared.dao_hr_policy_append_only();
CREATE OR REPLACE TRIGGER dao_hr_hiring_history_append_only BEFORE UPDATE ON harness_shared.dao_hr_hiring_history
  FOR EACH ROW EXECUTE FUNCTION harness_shared.dao_hr_policy_append_only();
