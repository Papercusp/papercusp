-- Migration 1100 — explicit public hosted-account admission (BYOC D-366/P-319).
--
-- Self-signup is a Papercusp-owned transaction, not an identity-provider
-- membership shortcut.  The attempt ledger is the idempotency/rate-limit
-- anchor; hosted_service owns it and the resulting entitlement projection.
-- There are deliberately no credentials or provider tokens in either table.

CREATE SCHEMA IF NOT EXISTS papercusp_auth;

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_signup_attempts (
  attempt_id       text PRIMARY KEY,
  provider         text NOT NULL,
  subject          text NOT NULL,
  email            text NOT NULL,
  fingerprint      text NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  user_id          uuid,
  organization_id  uuid,
  session_id       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hosted_signup_attempts_status_ck
    CHECK (status IN ('pending', 'completed', 'rate_limited')),
  CONSTRAINT hosted_signup_attempts_attempt_nonempty_ck CHECK (btrim(attempt_id) <> ''),
  CONSTRAINT hosted_signup_attempts_provider_nonempty_ck CHECK (btrim(provider) <> ''),
  CONSTRAINT hosted_signup_attempts_subject_nonempty_ck CHECK (btrim(subject) <> ''),
  CONSTRAINT hosted_signup_attempts_email_nonempty_ck CHECK (btrim(email) <> ''),
  CONSTRAINT hosted_signup_attempts_fingerprint_nonempty_ck CHECK (btrim(fingerprint) <> ''),
  CONSTRAINT hosted_signup_attempts_completed_refs_ck CHECK (
    (status = 'completed' AND user_id IS NOT NULL AND organization_id IS NOT NULL AND session_id IS NOT NULL)
    OR (status <> 'completed')
  )
);

CREATE INDEX IF NOT EXISTS hosted_signup_attempts_email_created_idx
  ON papercusp_auth.hosted_signup_attempts (email, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS hosted_signup_attempts_provider_subject_idx
  ON papercusp_auth.hosted_signup_attempts (provider, subject)
  WHERE status = 'completed';

CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_entitlements (
  organization_id uuid NOT NULL,
  user_id         uuid NOT NULL,
  kind            text NOT NULL,
  source          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id, kind),
  CONSTRAINT hosted_entitlements_kind_ck CHECK (btrim(kind) <> ''),
  CONSTRAINT hosted_entitlements_source_ck CHECK (btrim(source) <> '')
);

CREATE INDEX IF NOT EXISTS hosted_entitlements_user_idx
  ON papercusp_auth.hosted_entitlements (user_id, organization_id);

COMMENT ON TABLE papercusp_auth.hosted_signup_attempts IS
  'Idempotency and abuse-control ledger for explicit public hosted signup. Contains no credential material.';
COMMENT ON TABLE papercusp_auth.hosted_entitlements IS
  'Papercusp-owned entitlement granted by an approved signup admission transaction.';

ALTER TABLE papercusp_auth.hosted_signup_attempts OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_entitlements OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_signup_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_signup_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_entitlements FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  papercusp_auth.hosted_signup_attempts,
  papercusp_auth.hosted_entitlements
FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;
GRANT SELECT, INSERT, UPDATE ON
  papercusp_auth.hosted_signup_attempts,
  papercusp_auth.hosted_entitlements
TO hosted_service;

DROP POLICY IF EXISTS hosted_signup_attempts_service_all
  ON papercusp_auth.hosted_signup_attempts;
CREATE POLICY hosted_signup_attempts_service_all
  ON papercusp_auth.hosted_signup_attempts
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS hosted_entitlements_service_all
  ON papercusp_auth.hosted_entitlements;
CREATE POLICY hosted_entitlements_service_all
  ON papercusp_auth.hosted_entitlements
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);

DO $mig1188$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'papercusp_auth'
       AND table_name IN ('hosted_signup_attempts', 'hosted_entitlements')
       AND column_name ~* '(password|hash|secret|token|credential|cookie|mfa)'
  ) THEN
    RAISE EXCEPTION '1188: hosted self-signup tables contain forbidden credential columns';
  END IF;
  IF NOT has_table_privilege('hosted_service', 'papercusp_auth.hosted_signup_attempts', 'SELECT, INSERT, UPDATE')
     OR NOT has_table_privilege('hosted_service', 'papercusp_auth.hosted_entitlements', 'SELECT, INSERT, UPDATE') THEN
    RAISE EXCEPTION '1188: hosted_service self-signup DML surface is incomplete';
  END IF;
END
$mig1188$;
