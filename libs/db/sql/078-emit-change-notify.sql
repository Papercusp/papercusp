-- 078: emit_change_notify — generic trigger function that emits a
-- pg_notify on every INSERT / UPDATE / DELETE of an attached table.
--
-- Per papercusp-dogfood-v5 Phase 3 P-018. This is the producer side
-- of the reactivity stack:
--
--   PG (this trigger) → pg_notify('papercusp_changes', json)
--                    → LISTEN in /api/sync/stream (P-020 — separate)
--                    → SSE to browser
--                    → libs/sync SSEAdapter → useSyncQuery invalidation
--
-- The function is intentionally **generic**: one function, attached to
-- many tables via separate triggers in P-019. The payload is coarse
-- by design — just (table, op, workspace_id). PK-aware fine-grained
-- invalidation is a later optimization; today's UI invalidates table-
-- level queries which is correct + simple.
--
-- Why the `true` flag on current_setting: the GUC `papercusp.workspace_id`
-- may not be set on every write path (system-level inserts, migrations,
-- backfills). `current_setting(name, missing_ok)` with missing_ok=true
-- returns NULL instead of raising. Listeners handle a NULL workspace_id
-- by either ignoring (system inserts that don't need to invalidate
-- anything in a workspace) or fanning out (rare; broadcast to all
-- workspaces).
--
-- Idempotent (CREATE OR REPLACE FUNCTION). Named dollar-quote per
-- `feedback_named_dollar_quote_in_sql` memory rule — never use
-- unnamed `$$` in migrations (heredoc + bash collapse hazard).

CREATE OR REPLACE FUNCTION harness_shared.emit_change_notify()
RETURNS TRIGGER AS $body$
DECLARE
  payload jsonb;
  ws_id   text;
BEGIN
  ws_id := current_setting('papercusp.workspace_id', true);

  payload := jsonb_build_object(
    'table',        TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
    'op',           TG_OP,
    'workspace_id', ws_id,
    'ts',           extract(epoch from now())
  );

  PERFORM pg_notify('papercusp_changes', payload::text);

  -- For DELETE triggers, the legal return is OLD. For INSERT/UPDATE,
  -- return NEW. The trigger is declared AFTER so the value is unused,
  -- but PostgreSQL still requires a structurally-valid return.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$body$ LANGUAGE plpgsql;

-- Note: this migration deliberately does NOT attach the trigger to any
-- table. Attachment is per-table and lives in P-019 (separate file 079+).
-- This split makes it easy to:
--   1. Add new reactive tables later (just one CREATE TRIGGER each)
--   2. Detach a noisy table without dropping the function
--   3. Review the producer surface as a list of trigger attachments
