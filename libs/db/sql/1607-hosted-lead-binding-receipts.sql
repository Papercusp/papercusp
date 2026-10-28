-- P019 / D-052: explicit identity association, separate from analytics consent.
-- Contains no token, signing key, email or browser attribution.
-- FORWARD-COMPAT: this additive new table has no prior rows or uniqueness
-- contract; the two unique indexes constrain only newly issued binding proof.
CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_lead_bindings (
  challenge_id uuid PRIMARY KEY,
  graph_workspace_id text NOT NULL CHECK (btrim(graph_workspace_id) <> '' AND graph_workspace_id <> '*'),
  person_ref text NOT NULL CHECK (person_ref ~ '^PER-[A-Za-z0-9-]{1,160}$'),
  environment text NOT NULL CHECK (environment IN ('development', 'staging', 'production')),
  issuer_ref text NOT NULL CHECK (btrim(issuer_ref) <> ''),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  organization_id uuid REFERENCES papercusp_auth.organizations(id),
  user_id uuid REFERENCES papercusp_auth.hosted_users(id),
  redeemed_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT hosted_lead_binding_window CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '15 minutes'),
  CONSTRAINT hosted_lead_binding_redemption CHECK (
    (redeemed_at IS NULL AND organization_id IS NULL AND user_id IS NULL) OR
    (redeemed_at IS NOT NULL AND organization_id IS NOT NULL AND user_id IS NOT NULL
      AND redeemed_at >= issued_at AND redeemed_at < expires_at)),
  CONSTRAINT hosted_lead_binding_revocation CHECK (revoked_at IS NULL OR revoked_at >= coalesce(redeemed_at, issued_at))
);
CREATE UNIQUE INDEX IF NOT EXISTS hosted_lead_binding_person_active
  ON papercusp_auth.hosted_lead_bindings(graph_workspace_id, person_ref, environment, organization_id)
  WHERE redeemed_at IS NOT NULL AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hosted_lead_binding_user_active
  ON papercusp_auth.hosted_lead_bindings(graph_workspace_id, environment, organization_id, user_id)
  WHERE redeemed_at IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS hosted_lead_binding_expiry
  ON papercusp_auth.hosted_lead_bindings(expires_at) WHERE redeemed_at IS NULL;

CREATE OR REPLACE FUNCTION papercusp_auth.guard_hosted_lead_binding()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $guard$
BEGIN
  IF ROW(NEW.challenge_id, NEW.graph_workspace_id, NEW.person_ref, NEW.environment, NEW.issuer_ref, NEW.issued_at, NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.challenge_id, OLD.graph_workspace_id, OLD.person_ref, OLD.environment, OLD.issuer_ref, OLD.issued_at, OLD.expires_at)
    OR (OLD.redeemed_at IS NOT NULL AND ROW(NEW.organization_id, NEW.user_id, NEW.redeemed_at)
      IS DISTINCT FROM ROW(OLD.organization_id, OLD.user_id, OLD.redeemed_at))
    OR (OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'hosted lead binding proof is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
DROP TRIGGER IF EXISTS guard_hosted_lead_binding ON papercusp_auth.hosted_lead_bindings;
CREATE TRIGGER guard_hosted_lead_binding BEFORE UPDATE ON papercusp_auth.hosted_lead_bindings
  FOR EACH ROW EXECUTE FUNCTION papercusp_auth.guard_hosted_lead_binding();
ALTER TABLE papercusp_auth.hosted_lead_bindings OWNER TO hosted_owner;
ALTER FUNCTION papercusp_auth.guard_hosted_lead_binding() OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.hosted_lead_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.hosted_lead_bindings FORCE ROW LEVEL SECURITY;
REVOKE ALL ON papercusp_auth.hosted_lead_bindings FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service;
REVOKE ALL ON FUNCTION papercusp_auth.guard_hosted_lead_binding() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON papercusp_auth.hosted_lead_bindings TO hosted_service;
DROP POLICY IF EXISTS hosted_lead_bindings_service ON papercusp_auth.hosted_lead_bindings;
CREATE POLICY hosted_lead_bindings_service ON papercusp_auth.hosted_lead_bindings
  FOR ALL TO hosted_service USING (true) WITH CHECK (true);
