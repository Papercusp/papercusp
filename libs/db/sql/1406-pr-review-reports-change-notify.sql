-- pr_review_reports is mapped to harnessPrs.byHarness/detail for sync invalidation,
-- so raw-SQL and federated writes need the same producer as app-route writes.
-- Replacing the named trigger keeps this migration safe to reapply.
CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.pr_review_reports
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
