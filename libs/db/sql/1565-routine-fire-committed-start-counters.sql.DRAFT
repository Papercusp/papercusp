-- P-003/R-1. Physical routineFire INSERT counts, not claims/attempts or retained
-- workflow history. No existing counter retains these dimensions across GC.
-- Reuse the migration plane and operator_settings coverage provenance. Local
-- telemetry, one row per UTC hour/routine, seven-day retention, no backfill.
CREATE TABLE IF NOT EXISTS harness_shared.routine_fire_start_counts (
  bucket_start_ms bigint NOT NULL,
  workspace_id text NOT NULL,
  install_slug text NOT NULL,
  routine_id text NOT NULL,
  target_role text NOT NULL,
  starts bigint NOT NULL CHECK (starts > 0),
  PRIMARY KEY (bucket_start_ms, workspace_id, install_slug, routine_id, target_role)
);
ALTER TABLE harness_shared.routine_fire_start_counts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS routine_fire_start_counts_workspace ON harness_shared.routine_fire_start_counts;
CREATE POLICY routine_fire_start_counts_workspace ON harness_shared.routine_fire_start_counts
  USING (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION harness_shared.count_committed_routine_fire_start()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  args jsonb;
  bucket bigint := floor(extract(epoch FROM clock_timestamp()) / 3600)::bigint * 3600000;
  ws text := '@unattributed';
  install text := '@unattributed';
  routine text := '@unattributed';
  role_name text := '@unattributed';
BEGIN
  -- New/malformed serializers remain explicitly unknown; never silently omit
  -- an insertion, and never reject dispatch over attribution parsing.
  BEGIN
    args := NEW.inputs::jsonb;
    IF jsonb_typeof(args) = 'object' THEN args := args->'json'; END IF;
    IF jsonb_typeof(args) = 'array'
       AND jsonb_typeof(args->0) = 'string' AND length(args->>0) > 0
       AND jsonb_typeof(args->1) = 'string' AND length(args->>1) > 0
       AND jsonb_typeof(args->2) = 'string' AND length(args->>2) > 0
       AND jsonb_typeof(args->3) = 'string' AND length(args->>3) > 0 THEN
      routine := args->>0; ws := args->>1; install := args->>2; role_name := args->>3;
    END IF;
  EXCEPTION WHEN invalid_text_representation THEN NULL;
  END;
  INSERT INTO harness_shared.routine_fire_start_counts AS c
    (bucket_start_ms, workspace_id, install_slug, routine_id, target_role, starts)
  VALUES (bucket, ws, install, routine, role_name, 1)
  ON CONFLICT (bucket_start_ms, workspace_id, install_slug, routine_id, target_role)
  DO UPDATE SET starts = c.starts + 1;
  DELETE FROM harness_shared.routine_fire_start_counts
    WHERE bucket_start_ms < bucket - 7 * 86400000;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION harness_shared.install_routine_fire_start_counter()
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF to_regclass('dbos.workflow_status') IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'dbos.workflow_status'::regclass
        AND tgname = 'routine_fire_committed_start_counter' AND tgenabled = 'O') THEN RETURN; END IF;
  DROP TRIGGER IF EXISTS routine_fire_committed_start_counter ON dbos.workflow_status;
  CREATE TRIGGER routine_fire_committed_start_counter AFTER INSERT ON dbos.workflow_status
    FOR EACH ROW WHEN (NEW.name = 'routineFire')
    EXECUTE FUNCTION harness_shared.count_committed_routine_fire_start();
  -- Reinstallation resets coverage rather than concealing a missing interval.
  INSERT INTO harness_shared.operator_settings (key, value, description, updated_at)
    VALUES ('routine_fire_start_counter_since_ms',
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text,
      'Continuous routineFire INSERT counter coverage; UTC-hour windows only.',
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
END;
$$;

-- Fresh app migrations precede SDK table creation. Attach at that DDL boundary
-- too; no periodic writer or runtime ensure-table path. Nested CREATE TRIGGER
-- does not recurse because the event is restricted to CREATE TABLE.
CREATE OR REPLACE FUNCTION harness_shared.routine_fire_counter_on_dbos_create()
RETURNS event_trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands()
      WHERE objid = to_regclass('dbos.workflow_status')) THEN
    PERFORM harness_shared.install_routine_fire_start_counter();
  END IF;
END;
$$;
DROP EVENT TRIGGER IF EXISTS routine_fire_counter_dbos_create;
CREATE EVENT TRIGGER routine_fire_counter_dbos_create ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE')
  EXECUTE FUNCTION harness_shared.routine_fire_counter_on_dbos_create();
SELECT harness_shared.install_routine_fire_start_counter();
REVOKE ALL ON FUNCTION harness_shared.install_routine_fire_start_counter() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
    GRANT SELECT ON harness_shared.routine_fire_start_counts TO harness_app;
  END IF;
END $$;

COMMENT ON TABLE harness_shared.routine_fire_start_counts IS
  'GC-independent committed routineFire INSERT counts in UTC-hour buckets; seven-day retention. Rollback rolls back its count; duplicate admission does not increment it. Unknown attribution is explicit. No historical backfill.';
