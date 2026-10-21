-- 1548: sync invalidation for the plan-type registry
-- (plan-item-types-registry-cupboard-2026-10-20 P-007, D-009).
--
-- The Plans pane's `plans.itemTypeView` sync query resolves every plan item through the type
-- registry at the plan's pinned revisions, and reads a completion schema from the datatype
-- registry when an item type references a datatype. None of these tables emitted a change
-- notification, so defining a type, installing a type pack, pinning a plan or installing a
-- datatype left an open panel showing the old view until it remounted.
--
-- Attach the shared `emit_change_notify` trigger (the same one every bridged table uses) so each
-- write reaches the TABLE_TO_QUERY_NAMES bridge. `plan_type_pins` rows carry plan_slug and
-- harness_slug, so a pin write invalidates only that plan's view.
--
-- Additive only: no existing trigger, column or index changes.

DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.plan_item_type_definitions;
CREATE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.plan_item_type_definitions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.plan_type_definitions;
CREATE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.plan_type_definitions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.plan_type_pins;
CREATE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.plan_type_pins
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.datatype_registry;
CREATE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.datatype_registry
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
