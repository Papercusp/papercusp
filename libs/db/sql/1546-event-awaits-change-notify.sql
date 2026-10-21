-- Migration 1546 — change notifications for event_awaits, minus the inbox-wake plumbing
-- (plan event-wait-settlement-2026-10-20 P-009, work item WI-6554700010018160).
--
-- WHY. The Work-tab dependency graph now shows event waits on items (the
-- `workItems.depWaits` sync query): session events:await rows bound to an item, its
-- holder's other awaits, and the item's own event/gate blockers. Blockers live on
-- work_items, which already notifies. Awaits live on harness_shared.event_awaits, which had
-- NO change trigger at all, so an open pane would never see a wait register, fire or be
-- cancelled until some unrelated work_items write happened to bust the query.
--
-- WHAT. One row trigger that publishes `harness_shared.event_awaits.changed` on the
-- `sync_invalidate` channel (the shape emit_work_item_dep_change_notify already uses), and
-- the table-to-query-names bridge maps it to workItems.depWaits.
--
-- THE WHEN CLAUSE IS THE COST CONTROL. Every live agent re-arms its standing
-- `coord:inbox-wake:<owner>` await every turn, and none of those rows is a wait the graph
-- shows (derive-awaiting.ts excludes them for the same reason). The row-level WHEN is
-- evaluated before the function is called, so those writes pay a string comparison and
-- nothing else. MEASURED 2026-10-21 on papercusp: 68 event_awaits rows created in the last
-- hour, 32 of them non-inbox; 20 non-inbox fires and 11 non-inbox cancels in the same hour.
-- The sync bus also dedupes a full-bust name per 90 s window.
--
-- Additive only: a new function and two new triggers. Nothing is dropped or renamed, and
-- the currently-deployed release neither reads nor writes anything this changes.

CREATE OR REPLACE FUNCTION harness_shared.emit_event_await_change_notify()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  row_jsonb jsonb := to_jsonb(COALESCE(NEW, OLD));
BEGIN
  PERFORM pg_notify('sync_invalidate', jsonb_build_object(
    'name', 'harness_shared.event_awaits.changed',
    'args', jsonb_build_object(
      'workspace_id', current_setting('app.workspace_id', true),
      'op', TG_OP,
      'id', row_jsonb -> 'id'
    )
  )::text);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER emit_event_await_change_notify_write_trg
  AFTER INSERT OR UPDATE ON harness_shared.event_awaits
  FOR EACH ROW
  WHEN (NEW.event_key NOT LIKE 'coord:inbox-wake:%')
  EXECUTE FUNCTION harness_shared.emit_event_await_change_notify();

CREATE OR REPLACE TRIGGER emit_event_await_change_notify_delete_trg
  AFTER DELETE ON harness_shared.event_awaits
  FOR EACH ROW
  WHEN (OLD.event_key NOT LIKE 'coord:inbox-wake:%')
  EXECUTE FUNCTION harness_shared.emit_event_await_change_notify();
