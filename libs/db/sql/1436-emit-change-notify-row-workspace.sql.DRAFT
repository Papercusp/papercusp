-- EI-25579142918093536: scope change notifications to the changed row.
-- Direct coordination writers store workspace_id without setting a connection GUC.
-- A missing or stale GUC must not strand the row's cache invalidation in another
-- workspace. Extend the existing 1213 producer; preserve bulk coalescing, receipt
-- suppression, natural keys, payload shape and global-table GUC fallback.
-- CREATE OR REPLACE is idempotent; existing triggers keep their function binding.

CREATE OR REPLACE FUNCTION harness_shared.emit_change_notify()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  payload      jsonb;
  ws_id        text;
  q_name       text;
  row_id       jsonb;
  row_jsonb    jsonb;
  plan_slug    jsonb;
  harness_slug jsonb;
BEGIN
  q_name := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME || '.changed';
  row_jsonb := to_jsonb(COALESCE(NEW, OLD));
  -- Row scope is authoritative for direct writers and pooled connections.
  -- Global tables without workspace_id retain their connection-context scope.
  ws_id := COALESCE(row_jsonb ->> 'workspace_id', current_setting('app.workspace_id', true));

  -- WI-924391 — Resource-governor admission receipts are EPHEMERAL LOCAL QUEUE
  -- STATE. No sync query reads them (zero matches for resource_governor across the
  -- sync resolvers and apps/operator), yet each admission published four
  -- table-scoped sync_invalidate notifications as it moved
  -- queued->leased->running->completed, re-running EVERY work_items-backed query in
  -- EVERY connected client for state nothing displays.
  --
  -- Pinned to work_items explicitly: this function is shared by 88 tables, and the
  -- table test keeps the blast radius at exactly one of them rather than trusting
  -- that no other table ever stores a 'resource_governor' key under 'payload'.
  --
  -- This also makes the WI-924391 backlog reap safe: without it, deleting the
  -- ~776k terminal receipts would emit ~776k notifications at COMMIT.
  --
  -- jsonb_exists() rather than the `?` operator: `?` collides with the driver
  -- placeholder in some clients that also execute this SQL.
  IF TG_TABLE_SCHEMA = 'harness_shared'
     AND TG_TABLE_NAME = 'work_items'
     AND jsonb_exists(COALESCE(row_jsonb -> 'payload', '{}'::jsonb), 'resource_governor')
  THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- P-525 (D-013) — a bulk read-merge fold: one table-scoped payload per table per
  -- transaction (PG dedupes identical payloads), instead of one per row.
  IF current_setting('papercusp.sync_notify_coalesce', true) = 'on' THEN
    PERFORM pg_notify('sync_invalidate', jsonb_build_object(
      'name', q_name,
      'args', jsonb_build_object('workspace_id', ws_id, 'op', 'COALESCED')
    )::text);
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- WI-4513: fall back to `feature_id` for tables with no surrogate `id` column
  -- (work_items and its id-less feature_id-keyed siblings — see header audit).
  -- JSON null for every table with neither column, unchanged for every table
  -- that already has a real `id`.
  row_id := COALESCE(row_jsonb -> 'id', row_jsonb -> 'feature_id');

  plan_slug := row_jsonb -> 'plan_slug';
  harness_slug := row_jsonb -> 'harness_slug';

  payload := jsonb_build_object(
    'name', q_name,
    'args', jsonb_build_object(
      'workspace_id', ws_id,
      'op',           TG_OP,
      'id',           row_id,
      'plan_slug',    plan_slug,
      'harness_slug', harness_slug
    )
  );
  PERFORM pg_notify('sync_invalidate', payload::text);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
