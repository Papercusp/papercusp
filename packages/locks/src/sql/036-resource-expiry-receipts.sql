-- EI-27702677985252804: transaction-local receipts reuse the locks migration
-- and host seams. They roll back with the deletion; the host publishes only
-- after COMMIT and after checking the final FIFO successor. No durable outbox.
CREATE OR REPLACE FUNCTION resource_note_expired_exclusives(p_domain text, p_resources text[])
RETURNS void LANGUAGE plpgsql AS $func$
BEGIN
  PERFORM set_config('papercusp.resource_expiries',
    (COALESCE(NULLIF(current_setting('papercusp.resource_expiries', true), ''), '[]')::jsonb ||
     COALESCE((SELECT jsonb_agg(jsonb_build_object('coordinationDomain', p_domain, 'resource', r))
       FROM unnest(p_resources) AS r), '[]'::jsonb))::text, true);
END;
$func$;

CREATE OR REPLACE FUNCTION resource_take_expiry_releases()
RETURNS TABLE(coordination_domain text, resource text) LANGUAGE plpgsql AS $func$
DECLARE
  v_receipts jsonb := COALESCE(NULLIF(current_setting('papercusp.resource_expiries', true), ''), '[]')::jsonb;
BEGIN
  PERFORM set_config('papercusp.resource_expiries', '[]', true);
  RETURN QUERY
    SELECT DISTINCT r->>'coordinationDomain', r->>'resource'
      FROM jsonb_array_elements(v_receipts) AS r
     WHERE NOT EXISTS (
       SELECT 1 FROM agent_resource_locks l
        WHERE l.coordination_domain = r->>'coordinationDomain'
          AND l.resource = r->>'resource'
          AND l.mode = 'exclusive' AND l.expires_ts > clock_timestamp());
END;
$func$;

-- Evaluating the argument runs the atomic RPC first, so its sweep and cascade
-- finish before receipts are consumed, within the SAME statement and locks.
CREATE OR REPLACE FUNCTION resource_with_expiry_receipts(p_value jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $func$
BEGIN
  RETURN jsonb_build_object('value', p_value, 'expiredResources',
    COALESCE((SELECT jsonb_agg(jsonb_build_object('coordinationDomain', e.coordination_domain, 'resource', e.resource))
      FROM resource_take_expiry_releases() e), '[]'::jsonb));
END;
$func$;

CREATE OR REPLACE FUNCTION resource_sweep_expired_scoped(p_coordination_domain text, p_resource text)
RETURNS integer LANGUAGE plpgsql AS $func$
DECLARE
  v_locks int;
  v_queue int;
  v_exclusive text[];
BEGIN
  WITH deleted AS (
    DELETE FROM agent_resource_locks
     WHERE coordination_domain = p_coordination_domain AND resource = p_resource
       AND expires_ts <= clock_timestamp()
    RETURNING resource, mode
  )
  SELECT count(*)::int, array_agg(resource) FILTER (WHERE mode = 'exclusive')
    INTO v_locks, v_exclusive FROM deleted;
  IF cardinality(v_exclusive) > 0 THEN
    PERFORM resource_note_expired_exclusives(p_coordination_domain, v_exclusive);
  END IF;
  DELETE FROM agent_resource_exclusive_queue
   WHERE coordination_domain = p_coordination_domain AND resource = p_resource
     AND expires_ts <= clock_timestamp();
  GET DIAGNOSTICS v_queue = ROW_COUNT;
  RETURN v_locks + v_queue;
END;
$func$;
