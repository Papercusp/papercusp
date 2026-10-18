-- EI-26346711656063123: nested shared acquires borrow the incumbent lease.
-- Preserve its longer lifetime while still allowing an explicit renewal to
-- extend it. Both the transactional and atomic acquire paths use this RPC.

CREATE OR REPLACE FUNCTION resource_acquire_shared(
  p_feature_key          integer,
  p_coordination_domain  text,
  p_resource             text,
  p_owner                text,
  p_owner_label          text,
  p_reason               text,
  p_ttl_sec              integer,
  p_waiter_ttl_sec       integer,
  p_take_scope_locks     boolean,
  p_lock_timeout_ms      integer
)
RETURNS jsonb
LANGUAGE plpgsql AS $func$
DECLARE
  v_max_holders         integer;
  v_caller_holds_shared boolean;
  v_excl_owner          text;
  v_queue_len           integer;
  v_other_shared        integer;
  v_lock_id             uuid;
  v_expires             timestamptz;
  v_refusal             text;
BEGIN
  IF p_take_scope_locks THEN
    PERFORM resource_scope_lock(p_feature_key, p_coordination_domain, p_resource, p_lock_timeout_ms);
  END IF;

  SELECT r.max_holders INTO v_max_holders
    FROM agent_resource_registry r
   WHERE r.resource = p_resource
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_resource');
  END IF;

  PERFORM resource_sweep_expired_scoped(p_coordination_domain, p_resource);
  PERFORM resource_grant_cascade(p_coordination_domain, clock_timestamp(), p_resource);

  SELECT EXISTS (
    SELECT 1 FROM agent_resource_locks l
     WHERE l.coordination_domain = p_coordination_domain
       AND l.resource = p_resource
       AND l.owner = p_owner
       AND l.mode = 'shared'
       AND l.expires_ts > clock_timestamp()
  ) INTO v_caller_holds_shared;

  SELECT l.owner INTO v_excl_owner
    FROM agent_resource_locks l
   WHERE l.coordination_domain = p_coordination_domain
     AND l.resource = p_resource
     AND l.mode = 'exclusive'
     AND l.expires_ts > clock_timestamp()
   ORDER BY l.acquired_ts ASC
   LIMIT 1;

  SELECT count(*) INTO v_queue_len
    FROM agent_resource_exclusive_queue q
   WHERE q.coordination_domain = p_coordination_domain
     AND q.resource = p_resource
     AND q.expires_ts > clock_timestamp();

  -- Incumbent renewal retains the existing writer-priority and capacity rules.
  IF (v_excl_owner IS NOT NULL AND v_excl_owner <> p_owner AND NOT v_caller_holds_shared)
     OR (v_queue_len > 0 AND NOT v_caller_holds_shared AND v_excl_owner IS DISTINCT FROM p_owner) THEN
    v_refusal := 'exclusive_pending';
  ELSIF v_max_holders IS NOT NULL AND NOT v_caller_holds_shared THEN
    SELECT count(*) INTO v_other_shared
      FROM agent_resource_locks l
     WHERE l.coordination_domain = p_coordination_domain
       AND l.resource = p_resource
       AND l.mode = 'shared'
       AND l.owner <> p_owner
       AND l.expires_ts > clock_timestamp();
    IF v_other_shared >= v_max_holders THEN
      v_refusal := 'at_capacity';
    END IF;
  END IF;

  IF v_refusal IS NOT NULL THEN
    INSERT INTO agent_resource_waiters
      (coordination_domain, resource, owner, owner_label, expires_ts)
    VALUES
      (p_coordination_domain, p_resource, p_owner, p_owner_label,
       clock_timestamp() + (p_waiter_ttl_sec || ' seconds')::interval)
    ON CONFLICT (coordination_domain, resource, owner) DO UPDATE
      SET owner_label = EXCLUDED.owner_label,
          queued_ts   = clock_timestamp(),
          expires_ts  = EXCLUDED.expires_ts;
    RETURN jsonb_build_object('ok', false, 'reason', v_refusal);
  END IF;

  INSERT INTO agent_resource_locks AS l
    (coordination_domain, resource, owner, owner_label, mode, status, reason, expires_ts)
  VALUES
    (p_coordination_domain, p_resource, p_owner, p_owner_label, 'shared', 'held', p_reason,
     clock_timestamp() + (p_ttl_sec || ' seconds')::interval)
  ON CONFLICT (coordination_domain, resource, owner) DO UPDATE
    SET owner_label = EXCLUDED.owner_label,
        reason      = EXCLUDED.reason,
        mode        = 'shared',
        status      = 'held',
        acquired_ts = clock_timestamp(),
        expires_ts  = GREATEST(l.expires_ts, EXCLUDED.expires_ts)
    WHERE l.mode = 'shared'
  RETURNING l.lock_id, l.expires_ts INTO v_lock_id, v_expires;

  IF v_lock_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'held_exclusive');
  END IF;

  DELETE FROM agent_resource_waiters
   WHERE coordination_domain = p_coordination_domain
     AND resource = p_resource
     AND owner = p_owner;

  RETURN jsonb_build_object(
    'ok', true,
    'lock_id', v_lock_id::text,
    'expires_ts', v_expires,
    'reused', v_caller_holds_shared
  );
END;
$func$;
