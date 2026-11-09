-- Arm only after the backup-safe online prebuild is verified valid.
-- WI-6554700010046461: recipe outcome reports join dispatcher call identities
-- to tool_invocations. The workspace/harness/time index cannot constrain that
-- identity, and the normalized tool predicate cannot use the code:run-only
-- time index. A ten-minute report still scanned days of unrelated telemetry.
-- Reuse the telemetry table with a partial index covering both recipe doors;
-- keep cross-harness duplicate detection intact.
--
-- The migration runner uses a transaction. On the live history table, prebuild
-- this exact definition with CREATE INDEX CONCURRENTLY before applying this
-- idempotent migration, as with migration 1562.
CREATE INDEX IF NOT EXISTS tool_invocations_recipe_receipt_idx
  ON harness_shared.tool_invocations
    (workspace_id, ((metadata_json->'otel'->>'callId')), invoked_at)
  WHERE lower(replace(replace(tool_name, ':', ''), '_', '')) IN ('coderun', 'recipesrun');

-- IF NOT EXISTS also skips an index left INVALID by an interrupted concurrent
-- prebuild. Never stamp that as a successful migration: complete its online
-- REINDEX after the backup rendezvous clears, then reapply this migration.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = 'harness_shared.tool_invocations_recipe_receipt_idx'::regclass
      AND NOT indisvalid
  ) THEN
    RAISE EXCEPTION 'recipe receipt index is invalid; complete online REINDEX before applying migration 1624'
      USING ERRCODE = '55000';
  END IF;
END
$migration$;

COMMENT ON INDEX harness_shared.tool_invocations_recipe_receipt_idx IS
  'Recipe outcome receipt lookup by workspace, dispatcher call id and time, across harnesses';
