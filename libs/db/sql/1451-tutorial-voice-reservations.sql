-- P-011: seconds exposure, separate from money; account tutorials need no workspace.
-- Fixed read-only bridge to existing global policy; no hosted table/DML grant.
-- FORWARD-COMPAT: this migration creates the reservation table before its indexes;
-- deployed issuance remains disabled. Existing reservation writers omit the new
-- nullable attempt/conversation columns, so their NULL values do not conflict in
-- the unique identity indexes. The one-live-user index enforces the admission
-- invariant already used by the store; no old column or writer shape is removed.
CREATE OR REPLACE FUNCTION papercusp_auth.lock_tutorial_voice_global_flags()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $body$
DECLARE policy jsonb;
BEGIN
  SELECT payload INTO policy FROM harness_shared.operator_flag_overrides
    WHERE workspace_id = '@global' FOR UPDATE;
  IF policy IS NULL OR jsonb_typeof(policy) <> 'object' THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each(policy) AS entry
    WHERE jsonb_typeof(entry.value) <> 'boolean') THEN
    RETURN NULL;
  END IF;
  RETURN policy;
END;
$body$;
ALTER FUNCTION papercusp_auth.lock_tutorial_voice_global_flags() OWNER TO harness_admin;
REVOKE ALL ON FUNCTION papercusp_auth.lock_tutorial_voice_global_flags()
  FROM PUBLIC, harness_app, harness_zero, hosted_app, hosted_service;
GRANT EXECUTE ON FUNCTION papercusp_auth.lock_tutorial_voice_global_flags() TO hosted_service;
COMMENT ON FUNCTION papercusp_auth.lock_tutorial_voice_global_flags() IS
  'Service-only fixed global boolean policy read; caller transaction retains the row lock. No defaults, cutover creation, workspace selection or DML authority.';

CREATE TABLE IF NOT EXISTS papercusp_auth.tutorial_voice_reservations (
  id uuid PRIMARY KEY,
  control_workspace_id text NOT NULL,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  customer_workspace_id text,
  day date NOT NULL,
  maximum_seconds integer NOT NULL CHECK (maximum_seconds BETWEEN 1 AND 7200),
  provider_limit_ref text NOT NULL CHECK (length(provider_limit_ref) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  provider_final_ref text CHECK (length(provider_final_ref) BETWEEN 1 AND 256)
);
-- Commit an attempt before provider I/O; ambiguous responses retain exposure.
ALTER TABLE papercusp_auth.tutorial_voice_reservations
  ADD COLUMN IF NOT EXISTS issuance_attempt_id uuid,
  ADD COLUMN IF NOT EXISTS provider_conversation_id text;
DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'papercusp_auth.tutorial_voice_reservations'::regclass
      AND conname = 'tutorial_voice_remote_identity') THEN
    ALTER TABLE papercusp_auth.tutorial_voice_reservations
      ADD CONSTRAINT tutorial_voice_remote_identity CHECK (
        provider_conversation_id IS NULL OR (issuance_attempt_id IS NOT NULL
          AND length(provider_conversation_id) BETWEEN 1 AND 256));
  END IF;
END;
$body$;
CREATE UNIQUE INDEX IF NOT EXISTS tutorial_voice_unique_attempt
  ON papercusp_auth.tutorial_voice_reservations (issuance_attempt_id);
CREATE UNIQUE INDEX IF NOT EXISTS tutorial_voice_unique_conversation
  ON papercusp_auth.tutorial_voice_reservations (provider_conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS tutorial_voice_one_live_user
  ON papercusp_auth.tutorial_voice_reservations (user_id) WHERE provider_final_ref IS NULL;
CREATE INDEX IF NOT EXISTS tutorial_voice_daily ON papercusp_auth.tutorial_voice_reservations (day);
ALTER TABLE papercusp_auth.tutorial_voice_reservations OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.tutorial_voice_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.tutorial_voice_reservations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON papercusp_auth.tutorial_voice_reservations FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;
GRANT SELECT, INSERT ON papercusp_auth.tutorial_voice_reservations TO hosted_service;
GRANT UPDATE (provider_final_ref, issuance_attempt_id, provider_conversation_id)
  ON papercusp_auth.tutorial_voice_reservations TO hosted_service;
DROP POLICY IF EXISTS tutorial_voice_service ON papercusp_auth.tutorial_voice_reservations;
CREATE POLICY tutorial_voice_service ON papercusp_auth.tutorial_voice_reservations
  TO hosted_service USING (true) WITH CHECK (true);
CREATE OR REPLACE FUNCTION papercusp_auth.tutorial_voice_reservations_guard()
RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (
    OLD.provider_final_ref IS NOT NULL OR
    (OLD.issuance_attempt_id IS NOT NULL AND NEW.issuance_attempt_id IS DISTINCT FROM OLD.issuance_attempt_id) OR
    (OLD.provider_conversation_id IS NOT NULL AND NEW.provider_conversation_id IS DISTINCT FROM OLD.provider_conversation_id) OR
    ROW(NEW.id, NEW.control_workspace_id, NEW.organization_id, NEW.user_id,
      NEW.customer_workspace_id, NEW.day, NEW.maximum_seconds, NEW.provider_limit_ref, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.control_workspace_id, OLD.organization_id, OLD.user_id,
      OLD.customer_workspace_id, OLD.day, OLD.maximum_seconds, OLD.provider_limit_ref, OLD.created_at)
  )) THEN
    RAISE EXCEPTION 'tutorial voice exposure is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$body$;
ALTER FUNCTION papercusp_auth.tutorial_voice_reservations_guard() OWNER TO hosted_owner;
DROP TRIGGER IF EXISTS tutorial_voice_reservations_guard ON papercusp_auth.tutorial_voice_reservations;
CREATE TRIGGER tutorial_voice_reservations_guard BEFORE UPDATE OR DELETE
  ON papercusp_auth.tutorial_voice_reservations FOR EACH ROW
  EXECUTE FUNCTION papercusp_auth.tutorial_voice_reservations_guard();
COMMENT ON TABLE papercusp_auth.tutorial_voice_reservations IS
  'Full enforced duration charged at admission. No browser refunds or expiry release. Verified provider finality clears live-user exclusion; seconds remain charged.';
