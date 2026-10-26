-- P013/D021: extend existing scoped progress, not a parallel receipt ledger.
-- Newly installed instrumentation establishes NO pre-install history.
-- EXCLUSIVE-LOCK: ENABLE ALWAYS briefly locks tool_invocations to activate the
-- three statement triggers. Metadata-only; no source scan, delete or backfill.
-- The migration runner's bounded lock timeout/drain governs this transaction.
ALTER TABLE harness_shared.sql_intent_progress
  ADD COLUMN IF NOT EXISTS retained_from timestamptz NOT NULL DEFAULT clock_timestamp();

-- Statement transition tables keep a 10k-row prune batch to one scoped update.
-- Rewrites can also remove a row from its old scope or change mined evidence.
CREATE OR REPLACE FUNCTION harness_shared.sql_intent_retention_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  UPDATE harness_shared.sql_intent_progress AS p
     SET retained_from = GREATEST(p.retained_from, removed.last_at + interval '1 microsecond')
    FROM (SELECT workspace_id, harness_slug, max(invoked_at) AS last_at
            FROM old_invocations GROUP BY workspace_id, harness_slug) AS removed
   WHERE p.workspace_id = removed.workspace_id AND p.harness_slug = removed.harness_slug
     AND p.retained_from <= removed.last_at;
  RETURN NULL;
END $fn$;
CREATE OR REPLACE FUNCTION harness_shared.sql_intent_retention_truncated()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  UPDATE harness_shared.sql_intent_progress SET retained_from = GREATEST(retained_from, clock_timestamp());
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION harness_shared.sql_intent_retention_changed() FROM PUBLIC;
REVOKE ALL ON FUNCTION harness_shared.sql_intent_retention_truncated() FROM PUBLIC;

CREATE OR REPLACE TRIGGER sql_intent_retention_delete
AFTER DELETE ON harness_shared.tool_invocations
REFERENCING OLD TABLE AS old_invocations FOR EACH STATEMENT
EXECUTE FUNCTION harness_shared.sql_intent_retention_changed();
CREATE OR REPLACE TRIGGER sql_intent_retention_update
AFTER UPDATE ON harness_shared.tool_invocations
REFERENCING OLD TABLE AS old_invocations FOR EACH STATEMENT
EXECUTE FUNCTION harness_shared.sql_intent_retention_changed();
CREATE OR REPLACE TRIGGER sql_intent_retention_truncate
AFTER TRUNCATE ON harness_shared.tool_invocations FOR EACH STATEMENT
EXECUTE FUNCTION harness_shared.sql_intent_retention_truncated();
-- Also track replication-role deletes. The reader requires all three detectors.
ALTER TABLE harness_shared.tool_invocations ENABLE ALWAYS TRIGGER sql_intent_retention_delete;
ALTER TABLE harness_shared.tool_invocations ENABLE ALWAYS TRIGGER sql_intent_retention_update;
ALTER TABLE harness_shared.tool_invocations ENABLE ALWAYS TRIGGER sql_intent_retention_truncate;
