-- P-010: fixed organization-scoped export reads through hosted_owner.
-- Reuses the existing SECURITY DEFINER seam (1188, 1382); hosted_service
-- retains no directory, consent, preference, support or audit SELECT.
-- Browser authorization locks session + membership before setting the scope.

DO $policies$
DECLARE
  v_store text;
BEGIN
  FOREACH v_store IN ARRAY ARRAY[
    'harness_shared.customer_workspaces',
    'papercusp_auth.organization_audit_events',
    'papercusp_auth.legal_acceptances',
    'papercusp_auth.support_access_grants',
    'papercusp_auth.hosted_user_preferences'
  ] LOOP
    EXECUTE format('GRANT SELECT ON %s TO hosted_owner', v_store);
    EXECUTE format('DROP POLICY IF EXISTS hosted_customer_export_owner ON %s', v_store);
    EXECUTE format(
      'CREATE POLICY hosted_customer_export_owner ON %s FOR SELECT TO hosted_owner USING (
         current_setting(''app.workspace_id'', true) = ''hosted-control-plane-service''
         AND organization_id::text = NULLIF(current_setting(''app.organization_id'', true), '''')
       )', v_store);
  END LOOP;
END
$policies$;

CREATE OR REPLACE FUNCTION papercusp_auth.read_hosted_customer_export_rows(
  p_store text, p_organization_id text
)
RETURNS TABLE(data jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_organization_id IS NULL OR btrim(p_organization_id) = '' THEN
    RAISE EXCEPTION 'hosted customer export organization is required' USING ERRCODE = '22023';
  END IF;
  IF current_setting('app.workspace_id', true) IS DISTINCT FROM 'hosted-control-plane-service'
     OR current_setting('app.organization_id', true) IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'hosted customer export service scope is invalid' USING ERRCODE = '42501';
  END IF;
  IF p_store IS NULL OR p_store NOT IN (
    'harness_shared.customer_workspaces',
    'papercusp_auth.organization_audit_events',
    'papercusp_auth.legal_acceptances',
    'papercusp_auth.support_access_grants',
    'papercusp_auth.hosted_user_preferences'
  ) THEN
    RAISE EXCEPTION 'hosted customer export store is not allowed' USING ERRCODE = '42501';
  END IF;
  -- p_store is one of the exact code-owned constants above, never SQL input.
  -- The consumer validates catalog/map parity and projects mapped safe columns.
  RETURN QUERY EXECUTE format(
    'SELECT to_jsonb(t) FROM %s t WHERE t.organization_id::text = $1', p_store
  ) USING p_organization_id;
END
$function$;

ALTER FUNCTION papercusp_auth.read_hosted_customer_export_rows(text, text) OWNER TO hosted_owner;
REVOKE ALL ON FUNCTION papercusp_auth.read_hosted_customer_export_rows(text, text)
  FROM PUBLIC, harness_app, harness_zero, hosted_app, hosted_service;
GRANT EXECUTE ON FUNCTION papercusp_auth.read_hosted_customer_export_rows(text, text) TO hosted_service;

DO $postconditions$
BEGIN
  IF has_table_privilege('hosted_service', 'harness_shared.customer_workspaces', 'SELECT') THEN
    RAISE EXCEPTION '1509: hosted_service must not receive direct customer_workspaces SELECT';
  END IF;
  IF NOT has_function_privilege('hosted_service',
    'papercusp_auth.read_hosted_customer_export_rows(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '1509: hosted_service export bridge is not executable';
  END IF;
END
$postconditions$;
