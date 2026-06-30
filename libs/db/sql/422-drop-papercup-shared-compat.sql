-- 422-drop-papercup-shared-compat.sql
-- CONTRACT phase of papercup_shared -> papercusp_shared (Brief 11; phase5 P-009 / migration P-005).
-- EXPAND (migration 332) renamed the 6 base tables into papercusp_shared and left
-- papercup_shared as 6 auto-updatable compat VIEWS. This drops them + the schema.
-- IDEMPOTENT: no-op once papercup_shared is gone (DO/IF EXISTS), so a re-run on any
-- deploy is harmless. Replication-safe (0 publications/slots/subscriptions; views are
-- never logically replicated and the real tables live in papercusp_shared).
-- Gate verified 2026-06-24 and re-verified 2026-06-29 against the live DB + all three
-- running trees (dev/staging/release: 0 runtime refs) -- see
-- HANDOFF-papercup-rename-window-runbook-2026-06-24.md section 0.
-- Renumbered from the runbook's planned 394 (that slot was later taken by
-- 394-operator-quota-overrides.sql); 421 was the max on disk + recorded at apply time.
-- Reversal (data is untouched in papercusp_shared): recreate the 6 compat views with
--   CREATE SCHEMA papercup_shared; CREATE OR REPLACE VIEW papercup_shared.<t> AS SELECT * FROM papercusp_shared.<t>;
-- for t in (briefings, directive_summaries, directives, message_comments, message_recipients, messages).
DO $contract$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'papercup_shared') THEN
    DROP SCHEMA papercup_shared CASCADE;  -- CASCADE drops the 6 compat views (0 external deps verified)
    RAISE NOTICE 'CONTRACT: dropped papercup_shared compat views + schema';
  ELSE
    RAISE NOTICE 'CONTRACT: papercup_shared already absent -- no-op';
  END IF;
END
$contract$;
