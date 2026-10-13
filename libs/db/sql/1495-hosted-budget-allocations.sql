-- Enterprise readiness P-009 (WI-10007904): bounded organization -> department ->
-- project allocations and pilot outcome-cost records on the existing hosted
-- budget seam (1352 hosted_budget_receipts; same organization advisory lock).
-- Append-only tables; no existing data or role is widened or rewritten.
-- Allocation figures are engineering inputs on the ASSUMED enterprise profile
-- (docs/evidence/enterprise-assumed-profile-2026-10-13.md), never buyer facts.

-- One immutable revision per allocation change. A tree per (organization,
-- month, cost class): model, hosting and subscription money never share a cap.
CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_budget_allocations (
  control_workspace_id text NOT NULL,
  organization_id text NOT NULL,
  allocation_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  parent_allocation_id text,
  level text NOT NULL CHECK (level IN ('organization', 'department', 'project')),
  cost_class text NOT NULL CHECK (cost_class IN ('model', 'hosting', 'subscription')),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  cap_micros bigint NOT NULL CHECK (cap_micros BETWEEN 0 AND 9007199254740991),
  -- Ceiling on money admitted but not yet provider-final under this subtree.
  max_unreconciled_micros bigint NOT NULL CHECK (max_unreconciled_micros BETWEEN 0 AND 9007199254740991),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 512),
  recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 256),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (control_workspace_id, organization_id, allocation_id, revision),
  CHECK ((level = 'organization') = (parent_allocation_id IS NULL)),
  CHECK (max_unreconciled_micros <= cap_micros),
  CHECK (allocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'),
  CHECK (parent_allocation_id IS NULL OR parent_allocation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$')
);
CREATE INDEX IF NOT EXISTS hosted_budget_allocations_tree_idx
  ON papercusp_auth.hosted_budget_allocations (control_workspace_id, organization_id, month, cost_class);

-- One immutable revision per hold observation. reservation_id is the same
-- identifier namespace as hosted_budget_receipts.reservation_id.
CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_budget_allocation_holds (
  control_workspace_id text NOT NULL,
  organization_id text NOT NULL,
  reservation_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  allocation_id text NOT NULL,
  cost_class text NOT NULL CHECK (cost_class IN ('model', 'hosting', 'subscription')),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  maximum_cost_micros bigint NOT NULL CHECK (maximum_cost_micros BETWEEN 0 AND 9007199254740991),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  cost_source text NOT NULL CHECK (cost_source IN ('unpriced', 'estimate', 'provider-reported', 'provider-billed')),
  cost_micros bigint CHECK (cost_micros BETWEEN 0 AND 9007199254740991),
  provider_final boolean NOT NULL,
  observed_at_ms bigint NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991),
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 512),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (control_workspace_id, organization_id, reservation_id, revision),
  CHECK ((cost_source = 'unpriced') = (cost_micros IS NULL)),
  CHECK (NOT provider_final OR cost_source = 'provider-billed'),
  CHECK (revision <> 1 OR (cost_source = 'unpriced' AND NOT provider_final)),
  CHECK (reservation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$')
);
CREATE INDEX IF NOT EXISTS hosted_budget_allocation_holds_allocation_idx
  ON papercusp_auth.hosted_budget_allocation_holds (control_workspace_id, organization_id, month, cost_class);

-- Pilot outcome cost: result cost, review effort and rework, each either a
-- value or an explicit unknown reason (never a silent zero). evidence_class
-- labels internal dogfood/synthetic rows so they are never read as customer data.
CREATE TABLE IF NOT EXISTS papercusp_auth.hosted_outcome_cost_records (
  control_workspace_id text NOT NULL,
  organization_id text NOT NULL,
  outcome_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  allocation_id text NOT NULL,
  workflow_ref text NOT NULL CHECK (length(workflow_ref) BETWEEN 1 AND 256),
  evidence_class text NOT NULL CHECK (evidence_class IN ('internal-simulation', 'synthetic', 'customer')),
  result_state text NOT NULL CHECK (result_state IN ('accepted', 'rejected', 'rework-requested', 'unknown')),
  result_unknown_reason text,
  reservation_ids text[] NOT NULL DEFAULT '{}',
  result_cost_micros bigint CHECK (result_cost_micros BETWEEN 0 AND 9007199254740991),
  result_cost_unknown_reason text,
  review_effort_seconds bigint CHECK (review_effort_seconds BETWEEN 0 AND 9007199254740991),
  review_effort_unknown_reason text,
  rework_count integer CHECK (rework_count >= 0),
  rework_unknown_reason text,
  observed_at_ms bigint NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991),
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 512),
  recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 256),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (control_workspace_id, organization_id, outcome_id, revision),
  CHECK ((result_state = 'unknown') = (result_unknown_reason IS NOT NULL)),
  CHECK ((result_cost_micros IS NULL) = (result_cost_unknown_reason IS NOT NULL)),
  CHECK ((review_effort_seconds IS NULL) = (review_effort_unknown_reason IS NOT NULL)),
  CHECK ((rework_count IS NULL) = (rework_unknown_reason IS NOT NULL)),
  CHECK (outcome_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$')
);

-- Revisions are dense and immutable fields never change (raw INSERTs included).
CREATE OR REPLACE FUNCTION papercusp_auth.hosted_budget_allocation_revision_guard()
RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE
  prior_revision bigint;
  same boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    json_build_array('hosted-budget', NEW.control_workspace_id::text, NEW.organization_id::text)::text, 0));
  IF TG_TABLE_NAME = 'hosted_budget_allocations' THEN
    SELECT revision, (parent_allocation_id IS NOT DISTINCT FROM NEW.parent_allocation_id
        AND level = NEW.level AND cost_class = NEW.cost_class AND month = NEW.month)
      INTO prior_revision, same FROM papercusp_auth.hosted_budget_allocations
      WHERE control_workspace_id = NEW.control_workspace_id AND organization_id = NEW.organization_id
        AND allocation_id = NEW.allocation_id ORDER BY revision DESC LIMIT 1;
  ELSIF TG_TABLE_NAME = 'hosted_budget_allocation_holds' THEN
    SELECT revision, (allocation_id = NEW.allocation_id AND cost_class = NEW.cost_class AND month = NEW.month
        AND maximum_cost_micros = NEW.maximum_cost_micros AND request_hash = NEW.request_hash
        AND observed_at_ms <= NEW.observed_at_ms AND (NOT provider_final OR NEW.provider_final))
      INTO prior_revision, same FROM papercusp_auth.hosted_budget_allocation_holds
      WHERE control_workspace_id = NEW.control_workspace_id AND organization_id = NEW.organization_id
        AND reservation_id = NEW.reservation_id ORDER BY revision DESC LIMIT 1;
  ELSE
    SELECT revision, (allocation_id = NEW.allocation_id AND workflow_ref = NEW.workflow_ref
        AND evidence_class = NEW.evidence_class)
      INTO prior_revision, same FROM papercusp_auth.hosted_outcome_cost_records
      WHERE control_workspace_id = NEW.control_workspace_id AND organization_id = NEW.organization_id
        AND outcome_id = NEW.outcome_id ORDER BY revision DESC LIMIT 1;
  END IF;
  IF prior_revision IS NULL THEN
    IF NEW.revision <> 1 THEN RAISE EXCEPTION '% first revision must be 1', TG_TABLE_NAME; END IF;
  ELSIF NEW.revision <> prior_revision + 1 OR NOT same THEN
    RAISE EXCEPTION '% revision must be dense and keep immutable fields', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$body$;

DO $grants$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hosted_budget_allocations', 'hosted_budget_allocation_holds', 'hosted_outcome_cost_records'] LOOP
    EXECUTE format('ALTER TABLE papercusp_auth.%I OWNER TO hosted_owner', t);
    EXECUTE format('ALTER TABLE papercusp_auth.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE papercusp_auth.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON papercusp_auth.%I FROM PUBLIC, harness_app, harness_zero, harness_admin, hosted_app, hosted_service', t);
    EXECUTE format('GRANT SELECT, INSERT ON papercusp_auth.%I TO hosted_service', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON papercusp_auth.%I', t || '_service', t);
    EXECUTE format('CREATE POLICY %I ON papercusp_auth.%I FOR ALL TO hosted_service USING (true) WITH CHECK (true)', t || '_service', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON papercusp_auth.%I', t || '_revision_guard', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON papercusp_auth.%I FOR EACH ROW EXECUTE FUNCTION papercusp_auth.hosted_budget_allocation_revision_guard()', t || '_revision_guard', t);
  END LOOP;
END
$grants$;
