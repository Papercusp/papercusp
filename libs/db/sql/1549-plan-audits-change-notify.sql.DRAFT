-- EI-26582812922777022: plans:get tags its cached latestAudit with plan_audits,
-- but migration 832 created this table without a change-stream producer.
-- Reuse the generic row/workspace-scoped notifier for local and federated writes.
-- Additive and compatible with older writers; no row shapes or write rules change.
CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.plan_audits
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
