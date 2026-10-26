-- P013: result-door settlement enriches a retained source; it does not delete
-- source input or change its identity. Do not reset coverage on that hot path.
-- EXCLUSIVE-LOCK: replacing/enabling one statement trigger is metadata-only;
-- bounded migration-runner lock timeout and drain apply. No source scan.
CREATE OR REPLACE FUNCTION harness_shared.sql_intent_retention_rewritten()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  UPDATE harness_shared.sql_intent_progress AS p
     SET retained_from = GREATEST(p.retained_from, removed.last_at + interval '1 microsecond')
    FROM (SELECT o.workspace_id, o.harness_slug, max(o.invoked_at) AS last_at
            FROM old_invocations AS o LEFT JOIN new_invocations AS n ON n.id=o.id
           WHERE ROW(o.workspace_id,o.harness_slug,o.invoked_at,o.tool_name,o.args_json,
                     o.coord_owner_id,o.role,o.call_origin,o.call_origin_source)
             IS DISTINCT FROM
                 ROW(n.workspace_id,n.harness_slug,n.invoked_at,n.tool_name,n.args_json,
                     n.coord_owner_id,n.role,n.call_origin,n.call_origin_source)
           GROUP BY o.workspace_id,o.harness_slug) AS removed
   WHERE p.workspace_id=removed.workspace_id AND p.harness_slug=removed.harness_slug
     AND p.retained_from <= removed.last_at;
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION harness_shared.sql_intent_retention_rewritten() FROM PUBLIC;
CREATE OR REPLACE TRIGGER sql_intent_retention_update
AFTER UPDATE ON harness_shared.tool_invocations
REFERENCING OLD TABLE AS old_invocations NEW TABLE AS new_invocations FOR EACH STATEMENT
EXECUTE FUNCTION harness_shared.sql_intent_retention_rewritten();
ALTER TABLE harness_shared.tool_invocations ENABLE ALWAYS TRIGGER sql_intent_retention_update;
