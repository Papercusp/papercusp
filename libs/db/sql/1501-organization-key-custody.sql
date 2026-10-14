-- 1501-organization-key-custody.sql
-- P-016b (plan papercusp-enterprise-readiness-roadmap-2026-10-09, WI-6554700010012353; decision D-020).
--
-- Envelope-encryption custody for organization data (data-governance/organization-keys.ts):
--   1. organization_key_custody: one row per organization. Names the customer-managed
--      key-encryption key (KEK) in the customer's KMS, its custody state, and the active
--      data-encryption key (DEK) version that new writes use.
--        enabled  - reads and writes work.
--        revoked  - every read fails closed with a typed error; re-enabling the KEK recovers.
--        shredded - the KEK is lost or destroyed. Irreversible: no transition leaves it.
--   2. organization_data_keys: one row per DEK version. Holds ONLY the DEK wrapped by the KEK.
--      Plaintext DEKs are never stored. A shredded row has its wrapped DEK removed.
--      active       - the version new writes use (exactly one per non-shredded organization).
--      decrypt-only - an older version kept so existing ciphertext stays readable until the
--                     re-encryption sweep moves it to the active version.
--
-- Additive only: new tables, functions and triggers. Nothing the deployed release reads changes.

CREATE TABLE IF NOT EXISTS harness_shared.organization_key_custody (
  organization_id    uuid        PRIMARY KEY,
  kek_provider       text        NOT NULL CHECK (kek_provider IN ('aws-kms', 'gcp-kms', 'test-kms')),
  kek_ref            text        NOT NULL CHECK (length(btrim(kek_ref)) > 0),
  kek_generation     integer     NOT NULL DEFAULT 1 CHECK (kek_generation >= 1),
  state              text        NOT NULL DEFAULT 'enabled' CHECK (state IN ('enabled', 'revoked', 'shredded')),
  active_dek_version integer     NOT NULL DEFAULT 1 CHECK (active_dek_version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS harness_shared.organization_data_keys (
  organization_id uuid        NOT NULL REFERENCES harness_shared.organization_key_custody (organization_id),
  dek_version     integer     NOT NULL CHECK (dek_version >= 1),
  kek_provider    text        NOT NULL CHECK (kek_provider IN ('aws-kms', 'gcp-kms', 'test-kms')),
  kek_ref         text        NOT NULL CHECK (length(btrim(kek_ref)) > 0),
  kek_generation  integer     NOT NULL CHECK (kek_generation >= 1),
  wrapped_dek     bytea,
  state           text        NOT NULL CHECK (state IN ('active', 'decrypt-only', 'shredded')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  rewrapped_at    timestamptz,
  PRIMARY KEY (organization_id, dek_version),
  -- A shredded DEK keeps no key material; every other DEK keeps its wrapped form.
  CONSTRAINT organization_data_keys_material_ck CHECK (
    (state = 'shredded' AND wrapped_dek IS NULL)
    OR (state <> 'shredded' AND wrapped_dek IS NOT NULL AND length(wrapped_dek) > 0)
  )
);

-- At most one active DEK per organization.
-- FORWARD-COMPAT: this partial index is on a table created by this same migration, so no deployed release reads or upserts it.
CREATE UNIQUE INDEX IF NOT EXISTS organization_data_keys_one_active_idx
  ON harness_shared.organization_data_keys (organization_id)
  WHERE state = 'active';

-- Shredding is terminal and custody rows are never deleted.
CREATE OR REPLACE FUNCTION harness_shared.organization_key_custody_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'organization_key_custody rows are never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'shredded' AND NEW.state <> 'shredded' THEN
    RAISE EXCEPTION 'organization % keys are shredded; shredding is irreversible', OLD.organization_id
      USING ERRCODE = '55000';
  END IF;
  IF NEW.organization_id <> OLD.organization_id THEN
    RAISE EXCEPTION 'organization_key_custody.organization_id is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.kek_generation < OLD.kek_generation OR NEW.active_dek_version < OLD.active_dek_version THEN
    RAISE EXCEPTION 'organization_key_custody generations only move forward' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS organization_key_custody_guard_trg ON harness_shared.organization_key_custody;
CREATE TRIGGER organization_key_custody_guard_trg
  BEFORE UPDATE OR DELETE ON harness_shared.organization_key_custody
  FOR EACH ROW EXECUTE FUNCTION harness_shared.organization_key_custody_guard();

-- A shredded DEK never regains key material, and DEK rows are never deleted.
CREATE OR REPLACE FUNCTION harness_shared.organization_data_keys_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'organization_data_keys rows are never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'shredded' AND NEW.state <> 'shredded' THEN
    RAISE EXCEPTION 'organization % DEK version % is shredded; shredding is irreversible',
      OLD.organization_id, OLD.dek_version USING ERRCODE = '55000';
  END IF;
  IF NEW.organization_id <> OLD.organization_id OR NEW.dek_version <> OLD.dek_version THEN
    RAISE EXCEPTION 'organization_data_keys identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS organization_data_keys_guard_trg ON harness_shared.organization_data_keys;
CREATE TRIGGER organization_data_keys_guard_trg
  BEFORE UPDATE OR DELETE ON harness_shared.organization_data_keys
  FOR EACH ROW EXECUTE FUNCTION harness_shared.organization_data_keys_guard();
