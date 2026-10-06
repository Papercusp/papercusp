-- 1409: what each admission did, and live refresh for the Slack-bugs view on /admin/admission
-- (plan slack-messages-to-bug-reports-2026-10-05 P-008, decision D-011).
--
-- 1. work_admissions.outcome. Since P-004 a bug admission goes through the one bug intake, which
--    either creates a bug or attaches the source to a bug that was already filed. The admission row
--    is written either way, so the row itself must say which happened: 'created' (this source made
--    the work item) or 'folded' (it landed on an existing one). Nothing else tells them apart
--    reliably: a Slack thread folded onto a bug an agent filed is the only admission on that bug.
--    Existing rows predate folding and keep the default.
--
-- 2. emit_change_notify on the two other tables the view reads, so an open page refetches when a
--    background ingest writes them (the sync bridge maps each table to its queries in
--    table-to-query-names.ts):
--      chat_bug_suggestions   every row is a chat suggestion
--      trigger_deliveries     carries every external event for every sink, so the trigger fires
--                             only for the chat admission sink's rows (refusals and errors)
--
-- Additive only: a new defaulted column and new triggers. The release still serving :3070 inserts
-- admissions without naming outcome and gets 'created', which is what it did.

ALTER TABLE harness_shared.work_admissions
  ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'created'
    CONSTRAINT work_admissions_outcome_chk CHECK (outcome IN ('created', 'folded'));

COMMENT ON COLUMN harness_shared.work_admissions.outcome IS
  'created: this source made the work item. folded: the bug intake attached this source to a bug that was already filed (slack P-004/P-008, D-011).';

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.chat_bug_suggestions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

CREATE OR REPLACE TRIGGER emit_change_notify_chat_admission_trg
  AFTER INSERT OR UPDATE ON harness_shared.trigger_deliveries
  FOR EACH ROW
  WHEN (NEW.sink_kind = 'data-source-chat-admission')
  EXECUTE FUNCTION harness_shared.emit_change_notify();
