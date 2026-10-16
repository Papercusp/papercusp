-- P-534: extend the existing host inventory and operation reservation ledger.
-- Nullable columns preserve every older writer. No second scheduler or allocation table.
ALTER TABLE harness_shared.workspace_hosts
  ADD COLUMN IF NOT EXISTS pool_observation JSONB
    CHECK (pool_observation IS NULL OR jsonb_typeof(pool_observation) = 'object');

ALTER TABLE harness_shared.workspace_host_operations
  ADD COLUMN IF NOT EXISTS admission_receipt JSONB
    CHECK (admission_receipt IS NULL OR jsonb_typeof(admission_receipt) = 'object');

COMMENT ON COLUMN harness_shared.workspace_hosts.pool_observation IS
  'Controller-authored capacity/clean-state observation, bound to host generation and controller fence. Never customer input.';
COMMENT ON COLUMN harness_shared.workspace_host_operations.admission_receipt IS
  'Immutable hosted admission input and result for replay; queued/running operations are VM/data reservations.';

-- Hosted roles have table-level DML grants. RLS limits their rows but cannot prove
-- controller provenance for a new field, so protect those fields independently.
CREATE OR REPLACE FUNCTION harness_shared.guard_workspace_host_pool_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, harness_shared
AS $guard$
DECLARE
  next_value jsonb := to_jsonb(NEW)->TG_ARGV[0];
  prior_value jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD)->TG_ARGV[0] ELSE 'null'::jsonb END;
BEGIN
  IF current_user IN ('hosted_app', 'hosted_service', 'hosted_owner')
     AND next_value IS DISTINCT FROM prior_value THEN
    RAISE EXCEPTION 'workspace_host_pool_controller_evidence_required' USING ERRCODE = '42501';
  END IF;
  IF TG_ARGV[0] = 'admission_receipt' AND TG_OP = 'UPDATE'
     AND prior_value <> 'null'::jsonb AND next_value IS DISTINCT FROM prior_value THEN
    RAISE EXCEPTION 'workspace_host_admission_receipt_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$guard$;
REVOKE ALL ON FUNCTION harness_shared.guard_workspace_host_pool_evidence() FROM PUBLIC;

CREATE OR REPLACE TRIGGER workspace_hosts_pool_controller_evidence
  BEFORE INSERT OR UPDATE OF pool_observation ON harness_shared.workspace_hosts
  FOR EACH ROW EXECUTE FUNCTION harness_shared.guard_workspace_host_pool_evidence('pool_observation');
CREATE OR REPLACE TRIGGER workspace_host_operations_admission_controller_evidence
  BEFORE INSERT OR UPDATE OF admission_receipt ON harness_shared.workspace_host_operations
  FOR EACH ROW EXECUTE FUNCTION harness_shared.guard_workspace_host_pool_evidence('admission_receipt');
