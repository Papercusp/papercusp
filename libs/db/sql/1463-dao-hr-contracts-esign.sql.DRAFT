-- P006: immutable registry-rendered contracts and provider execution proof.
-- Extends the offer lifecycle; person identities remain in shared work_items.
CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_contracts (
  workspace_id text NOT NULL, dao_slug text NOT NULL, offer_id text NOT NULL,
  contract_id text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','dispatching','signing','signed','binding','lapsed')),
  templates jsonb NOT NULL, merge_values jsonb NOT NULL, signers jsonb NOT NULL,
  can_bind boolean NOT NULL, source_pdf bytea NOT NULL,
  envelope_id text UNIQUE, signing_links jsonb,
  sealed_pdf bytea, audit_certificate bytea, document_hash text,
  completion_proof jsonb, completed_at timestamptz,
  hire_proposal_ref text, grant_id text, hire_transaction_hash text,
  created_by text NOT NULL CHECK (created_by ~ '^PER-'), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,dao_slug,offer_id),
  FOREIGN KEY (workspace_id,dao_slug,offer_id) REFERENCES harness_shared.dao_hr_offers,
  CHECK (state NOT IN ('signed','binding') OR
    (sealed_pdf IS NOT NULL AND audit_certificate IS NOT NULL AND document_hash ~ '^0x[0-9a-f]{64}$' AND completion_proof IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (state <> 'binding' OR (can_bind AND hire_proposal_ref IS NOT NULL AND grant_id IS NOT NULL AND hire_transaction_hash IS NOT NULL))
);
CREATE OR REPLACE FUNCTION harness_shared.dao_hr_contract_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.dao_slug IS DISTINCT FROM OLD.dao_slug
    OR NEW.offer_id IS DISTINCT FROM OLD.offer_id OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
    OR NEW.templates IS DISTINCT FROM OLD.templates OR NEW.merge_values IS DISTINCT FROM OLD.merge_values
    OR NEW.signers IS DISTINCT FROM OLD.signers OR NEW.can_bind IS DISTINCT FROM OLD.can_bind
    OR NEW.source_pdf IS DISTINCT FROM OLD.source_pdf OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'dao_hr contract source is immutable';
  END IF;
  IF OLD.document_hash IS NOT NULL AND
    (NEW.sealed_pdf IS DISTINCT FROM OLD.sealed_pdf OR NEW.audit_certificate IS DISTINCT FROM OLD.audit_certificate
      OR NEW.document_hash IS DISTINCT FROM OLD.document_hash OR NEW.completion_proof IS DISTINCT FROM OLD.completion_proof
      OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'dao_hr contract completion proof is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER dao_hr_contract_immutable BEFORE UPDATE ON harness_shared.dao_hr_contracts
  FOR EACH ROW EXECUTE FUNCTION harness_shared.dao_hr_contract_immutable();
