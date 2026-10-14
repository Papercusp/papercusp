-- 1498-governance-sensitive-actions.sql
-- P-006 (plan papercusp-enterprise-readiness-roadmap-2026-10-09, WI-10007901; decision D-015).
--
-- Extends the P-005 governance-policy layers (1497) with:
--   1. governance_delegations: expiring, revoke-only authority over a layer SUBTREE.
--      Capabilities: prepare (write/prepare changes), approve (approve a sensitive action),
--      delegate (grant a subset of one's own authority). A service identity (an agent
--      session or role principal) may hold ONLY 'prepare': it can never approve or delegate.
--   2. sensitive_action_requests / sensitive_action_approvals: a sensitive action is
--      prepared by one principal, approved by DISTINCT authorized principals, then executed
--      exactly once inside a short execution window. Replay, expiry and self-approval are
--      refused here as well as in code (defence in depth).
--
-- Additive only: new tables, functions and triggers. Nothing the deployed release reads changes.

CREATE TABLE IF NOT EXISTS harness_shared.governance_delegations (
  delegation_id     text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  principal         text        NOT NULL CHECK (length(btrim(principal)) > 0),
  principal_kind    text        NOT NULL CHECK (principal_kind IN ('human', 'service')),
  layer_id          text        NOT NULL REFERENCES harness_shared.governance_policy_layers (layer_id),
  capabilities      text[]      NOT NULL,
  granted_by        text        NOT NULL CHECK (length(btrim(granted_by)) > 0),
  reason            text        NOT NULL CHECK (length(btrim(reason)) > 0),
  granted_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  revoked_by        text,
  revocation_reason text,
  CONSTRAINT governance_delegations_capabilities_ck
    CHECK (cardinality(capabilities) > 0 AND capabilities <@ ARRAY['prepare', 'approve', 'delegate']::text[]),
  CONSTRAINT governance_delegations_service_prepare_only_ck
    CHECK (principal_kind = 'human' OR NOT (capabilities && ARRAY['approve', 'delegate']::text[])),
  CONSTRAINT governance_delegations_kind_matches_principal_ck
    CHECK ((principal_kind = 'human') = (principal ~ '^(admin|user):')),
  CONSTRAINT governance_delegations_no_self_grant_ck
    CHECK (granted_by <> principal OR granted_by = 'bootstrap'),
  CONSTRAINT governance_delegations_expiry_ck CHECK (expires_at > granted_at),
  CONSTRAINT governance_delegations_revocation_triplet_ck
    CHECK (
      (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
      OR (revoked_at IS NOT NULL AND length(btrim(revoked_by)) > 0 AND length(btrim(revocation_reason)) > 0)
    )
);

CREATE INDEX IF NOT EXISTS governance_delegations_principal_idx
  ON harness_shared.governance_delegations (principal, layer_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS governance_delegations_layer_idx
  ON harness_shared.governance_delegations (layer_id);

-- Auditable delegation: a grant row is immutable except for a one-time revocation, and is never deleted.
CREATE OR REPLACE FUNCTION harness_shared.governance_delegations_revoke_only()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'governance_delegations is revoke-only; DELETE is forbidden' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'governance_delegations revocation is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'governance_delegations may only be updated to revoke a delegation' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['revoked_at', 'revoked_by', 'revocation_reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revoked_at', 'revoked_by', 'revocation_reason']) THEN
    RAISE EXCEPTION 'governance_delegations grant fields are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS governance_delegations_revoke_only_trg ON harness_shared.governance_delegations;
CREATE TRIGGER governance_delegations_revoke_only_trg
  BEFORE UPDATE OR DELETE ON harness_shared.governance_delegations
  FOR EACH ROW EXECUTE FUNCTION harness_shared.governance_delegations_revoke_only();

CREATE TABLE IF NOT EXISTS harness_shared.sensitive_action_requests (
  request_id          text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workspace_id        text        NOT NULL CHECK (length(btrim(workspace_id)) > 0),
  action_kind         text        NOT NULL CHECK (length(btrim(action_kind)) > 0),
  -- The layer the action changes (may not exist yet) and the existing layer authority is resolved against.
  target_layer_id     text        NOT NULL,
  authority_layer_id  text        NOT NULL REFERENCES harness_shared.governance_policy_layers (layer_id),
  payload             jsonb       NOT NULL,
  payload_hash        text        NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  -- Simulate-before-apply: the chain revision and target version the server simulated against.
  chain_revision      text,
  base_version        integer     NOT NULL CHECK (base_version >= 0),
  simulation          jsonb       NOT NULL,
  prepared_by         text        NOT NULL CHECK (length(btrim(prepared_by)) > 0),
  reason              text        NOT NULL CHECK (length(btrim(reason)) > 0),
  required_approvals  integer     NOT NULL DEFAULT 1 CHECK (required_approvals BETWEEN 1 AND 5),
  status              text        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'executed', 'denied', 'expired', 'cancelled')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  approved_at         timestamptz,
  execute_by          timestamptz,
  executed_at         timestamptz,
  executed_by         text,
  result              jsonb,
  CONSTRAINT sensitive_action_requests_expiry_ck CHECK (expires_at > created_at),
  CONSTRAINT sensitive_action_requests_approved_ck
    CHECK (status NOT IN ('approved', 'executed') OR (approved_at IS NOT NULL AND execute_by IS NOT NULL)),
  CONSTRAINT sensitive_action_requests_executed_ck
    CHECK ((status = 'executed') = (executed_at IS NOT NULL AND executed_by IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS sensitive_action_requests_open_idx
  ON harness_shared.sensitive_action_requests (workspace_id, created_at)
  WHERE status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS sensitive_action_requests_target_idx
  ON harness_shared.sensitive_action_requests (target_layer_id, created_at);

CREATE TABLE IF NOT EXISTS harness_shared.sensitive_action_approvals (
  request_id  text        NOT NULL REFERENCES harness_shared.sensitive_action_requests (request_id),
  approver    text        NOT NULL CHECK (approver ~ '^(admin|user):'),
  decision    text        NOT NULL CHECK (decision IN ('approve', 'deny')),
  reason      text        NOT NULL CHECK (length(btrim(reason)) > 0),
  decided_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, approver)
);

-- Separation of duties and lifecycle, enforced at the row: the preparer can never approve its own
-- request, a decision lands only on a pending unexpired request, and decisions are append-only.
CREATE OR REPLACE FUNCTION harness_shared.sensitive_action_approvals_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
  req harness_shared.sensitive_action_requests%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'sensitive_action_approvals is append-only' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO req FROM harness_shared.sensitive_action_requests WHERE request_id = NEW.request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sensitive action request % does not exist', NEW.request_id USING ERRCODE = '23503';
  END IF;
  IF req.prepared_by = NEW.approver THEN
    RAISE EXCEPTION 'self-approval is forbidden: % prepared request %', NEW.approver, NEW.request_id
      USING ERRCODE = '42501';
  END IF;
  IF req.status <> 'pending' OR req.expires_at <= NEW.decided_at THEN
    RAISE EXCEPTION 'sensitive action request % is not pending (status %, expires %)', NEW.request_id, req.status, req.expires_at
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS sensitive_action_approvals_guard_trg ON harness_shared.sensitive_action_approvals;
CREATE TRIGGER sensitive_action_approvals_guard_trg
  BEFORE INSERT OR UPDATE OR DELETE ON harness_shared.sensitive_action_approvals
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sensitive_action_approvals_guard();

-- One-time execution: a terminal request never changes again, and execution happens only from
-- 'approved' inside the execution window.
CREATE OR REPLACE FUNCTION harness_shared.sensitive_action_requests_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sensitive_action_requests rows are never deleted' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('executed', 'denied', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'sensitive action request % is terminal (%)', OLD.request_id, OLD.status USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'executed' AND OLD.status <> 'approved' THEN
    RAISE EXCEPTION 'sensitive action request % can execute only from approved (was %)', OLD.request_id, OLD.status
      USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'executed' AND (OLD.execute_by IS NULL OR NEW.executed_at > OLD.execute_by) THEN
    RAISE EXCEPTION 'sensitive action request % execution window has closed', OLD.request_id USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'approved_at', 'execute_by', 'executed_at', 'executed_by', 'result'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'approved_at', 'execute_by', 'executed_at', 'executed_by', 'result']) THEN
    RAISE EXCEPTION 'sensitive action request % prepared fields are immutable', OLD.request_id USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS sensitive_action_requests_transition_guard_trg ON harness_shared.sensitive_action_requests;
CREATE TRIGGER sensitive_action_requests_transition_guard_trg
  BEFORE UPDATE OR DELETE ON harness_shared.sensitive_action_requests
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sensitive_action_requests_transition_guard();

COMMENT ON TABLE harness_shared.governance_delegations IS
  'P-006 / D-015: expiring, revoke-only authority over a governance policy layer subtree. Service identities hold only prepare. See packages/operator-core/lib/governance-policy/authority.ts.';
COMMENT ON TABLE harness_shared.sensitive_action_requests IS
  'P-006 / D-015: a prepared sensitive action (sample: org/department governance policy change). Executes once, after distinct approvals, inside execute_by. See packages/operator-core/lib/governance-policy/sensitive-action.ts.';
COMMENT ON TABLE harness_shared.sensitive_action_approvals IS
  'P-006 / D-015: append-only approve/deny decisions; the preparer can never approve its own request.';
