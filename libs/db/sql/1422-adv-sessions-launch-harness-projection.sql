SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

-- EI-25349866237234695: launch_spec contains multi-MB identity history. Exact
-- Sessions facets need one scalar, not a corpus-wide decode on every read.
-- SQL NULL means pending; JSON null means the launch has no harness. This keeps
-- reads exact while old rows are backfilled without rereading known-null JSON.
-- EXCLUSIVE-LOCK: metadata-only column/trigger changes commit before backfill;
-- do not use a STORED generated column, which rewrites the large launch payloads.
ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS launch_harness_projection jsonb;
COMMENT ON COLUMN harness_shared.adv_sessions.launch_harness_projection IS
  'Maintained launch_spec.harnessSlug scalar; SQL NULL=pending, JSON null=known absent. Trigger maintains every write.';

CREATE OR REPLACE FUNCTION harness_shared.adv_sessions_project_launch_harness()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, harness_shared
AS $$
BEGIN
  NEW.launch_harness_projection :=
    coalesce(to_jsonb(NEW.launch_spec ->> 'harnessSlug'), 'null'::jsonb);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS adv_sessions_project_launch_harness ON harness_shared.adv_sessions;
CREATE TRIGGER adv_sessions_project_launch_harness
  BEFORE INSERT OR UPDATE OF launch_spec, launch_harness_projection
  ON harness_shared.adv_sessions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.adv_sessions_project_launch_harness();

--> statement-breakpoint

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
-- Replaying a partial migration only touches pending rows. The trigger computes
-- the scalar once and leaves the existing TOASTed launch_spec value untouched.
UPDATE harness_shared.adv_sessions
   SET launch_harness_projection = launch_harness_projection
 WHERE launch_harness_projection IS NULL;
