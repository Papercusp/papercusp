-- 1474-blocked-requires-named-blocker.sql
-- WI-6554700010009155 — owner directive #1746 [owner 2026-10-12]: "How can there be
-- blocked things with no named blocker, shouldn't marking something blocked require naming the
-- blocker?" → "fix this".
--
-- work_items:set_state already refuses `blocked` without an active typed blocker, but other
-- doors did not: work_items:create accepted state:'blocked' (14 rows born blocked with nothing
-- named, e.g. WI-6554700010008642), and older rows predate the tool guard. Measured
-- 2026-10-12: 81 non-plan work rows were blocked with no blocker of any kind.
--
-- This makes the rule a property of the data, not of one tool: a LOCAL, ordinary-queue work row
-- (nature='work', lane IS NULL) may only ENTER status 'blocked' when it names what it waits on:
--   1. an active typed external blocker  — payload.externalBlockers[] with status 'active'
--      (work_items:set_blocker writes it BEFORE it flips the status);
--   2. a leader-triage reason            — non-empty payload.blockedReason
--      (issues-engineer.ts markLeaderTriage; it now writes the reason before the status);
--   3. a plan link                       — source_plan_slug (the plan item is the source of
--      truth for its own blocked status, set via plans:set-status);
--   4. an internal dependency edge       — a harness_shared.work_item_deps row naming it.
--
-- Scope is deliberately the TRANSITION INTO blocked (INSERT as blocked, or UPDATE OF status from
-- something else). Rows already blocked are not re-judged on unrelated updates, so a legacy row
-- can never make an unrelated write fail. Records/events, observation and other special lanes,
-- and federated (non-local) rows are out of scope.
--
-- Rerunnable: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.

CREATE OR REPLACE FUNCTION harness_shared.work_item_blocked_names_blocker()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  blockers jsonb;
BEGIN
  IF NEW.status IS DISTINCT FROM 'blocked' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM 'blocked' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.nature, 'work') <> 'work'
     OR NEW.lane IS NOT NULL
     OR COALESCE(NEW.origin, 'local') <> 'local' THEN
    RETURN NEW;
  END IF;

  -- 1. an active typed external blocker (work_items:set_blocker)
  blockers := NEW.payload -> 'externalBlockers';
  IF jsonb_typeof(blockers) = 'array' AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(blockers) AS b(value)
        WHERE b.value ->> 'status' = 'active'
     ) THEN
    RETURN NEW;
  END IF;

  -- 2. a leader-triage reason (markLeaderTriage)
  IF length(btrim(COALESCE(NEW.payload ->> 'blockedReason', ''))) > 0 THEN
    RETURN NEW;
  END IF;

  -- 3. a plan item: the plan is the source of truth for its blocked status
  IF NEW.source_plan_slug IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- 4. an internal dependency edge (work_items:link rel 'blocks')
  IF EXISTS (
       SELECT 1 FROM harness_shared.work_item_deps d
        WHERE d.workspace_id = NEW.workspace_id
          AND (d.blocked_ref = NEW.feature_id OR d.blocked_ref LIKE '%#' || NEW.feature_id)
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'work-item % cannot enter status blocked without naming its blocker', NEW.feature_id
    USING ERRCODE = 'check_violation',
          HINT = 'Name the blocker first: work_items:set_blocker { id, kind, capability, ref, summary, nextVerb } '
              || 'for an external event/gate/runtime/human blocker (it parks the item), '
              || 'work_items:link { id: <blocker-id>, target_id: <this-id>, rel: ''blocks'' } for another work-item, '
              || 'or plans:set-status for a plan item.';
END;
$fn$;

COMMENT ON FUNCTION harness_shared.work_item_blocked_names_blocker() IS
  'WI-6554700010009155: a local ordinary-queue work row may only enter status blocked when it names its blocker (active payload.externalBlockers, payload.blockedReason, source_plan_slug, or a work_item_deps edge).';

DROP TRIGGER IF EXISTS work_item_blocked_names_blocker ON harness_shared.work_items;
CREATE TRIGGER work_item_blocked_names_blocker
  BEFORE INSERT OR UPDATE OF status ON harness_shared.work_items
  FOR EACH ROW
  WHEN (NEW.status = 'blocked')
  EXECUTE FUNCTION harness_shared.work_item_blocked_names_blocker();
