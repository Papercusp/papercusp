-- 1399: change notifications for the Settings → Integrations ticket page
-- (plan linear-asana-task-sync-2026-10-05 P-007, design D-014; work item WI-10006367).
--
-- The `integrations.tickets` sync query reads a ticket source's status, sync times and config
-- (data_sources), its admission rules (admission_rules) and how many items it admitted
-- (work_admissions). A connector sync pass, a rule change and an admission each write one of these
-- tables, often from a background worker rather than the page's own routes. A per-row
-- emit_change_notify trigger is what makes those writes refetch an open page; the sync bridge maps
-- each table to the query in table-to-query-names.ts. Additive only: no existing trigger changes.

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.data_sources
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.admission_rules
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.work_admissions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
