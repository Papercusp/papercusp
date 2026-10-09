-- Migration 1433 — invalidate coord:inbox cache entries when events are deleted.
--
-- Migration 275 intentionally left DELETE out because its original consumer,
-- dev.coordFeed, was append-oriented. coord:inbox now caches readInbox results
-- under the coord_event_log tag. Message GC removes the backing rows, so without
-- a delete notification a cached inbox can keep returning msg_ids that
-- resolveMessageRef can no longer find.
--
-- Keep the same original-row filter as migration 275: per-subscriber fan-out
-- copies carry notify_kind and must not each invalidate the shared inbox cache.
-- emit_change_notify() handles DELETE using OLD and preserves the same sync
-- invalidation payload used by INSERT/UPDATE.

DROP TRIGGER IF EXISTS emit_change_notify_delete_trg ON harness_shared.coord_event_log;
CREATE TRIGGER emit_change_notify_delete_trg
  AFTER DELETE ON harness_shared.coord_event_log
  FOR EACH ROW
  WHEN ((OLD.body->>'notify_kind') IS NULL)
  EXECUTE FUNCTION harness_shared.emit_change_notify();
