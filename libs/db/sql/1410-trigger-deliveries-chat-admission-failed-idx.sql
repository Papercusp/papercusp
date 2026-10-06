-- 1410: an index for the Slack-bugs view's refusals and errors
-- (plan slack-messages-to-bug-reports-2026-10-05 P-008, decision D-011).
--
-- The view on /admin/admission reads the chat admission sink's failed deliveries per data source.
-- trigger_deliveries is shared by every sink of every external source, and its heap is far larger
-- than its live rows (measured 2026-10-06: 123 MB heap for ~242 live rows), so without an index
-- each refetch of the view would scan the whole heap. Partial on exactly the rows the view reads,
-- so it stays small and costs nothing on any other sink's writes.

CREATE INDEX IF NOT EXISTS trigger_deliveries_chat_admission_failed_idx
  ON harness_shared.trigger_deliveries (workspace_id, source_id, updated_at DESC)
  WHERE sink_kind = 'data-source-chat-admission' AND outcome = 'failed';
