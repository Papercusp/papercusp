-- 1477-blocked-reason-freshness-and-review-park.sql
-- WI-6554700010009273 — residue of WI-6554700010009155 (owner directive #1746 [owner 2026-10-12]:
-- blocked items must name their blocker → "fix this"). Amends the migration-1474 trigger
-- function harness_shared.work_item_blocked_names_blocker() in two ways.
--
-- 1. A pending AGENT REVIEW is a named blocker (fixes EI-25807214698674439).
--    improvements:capture parks a fresh capture in `blocked` while it enrols the capture in
--    agent review, then reopens it. That park names nothing in the shapes 1474 accepts, so since
--    1474 applied (2026-10-12 19:49Z) every review-routed capture was refused at the park
--    ("cannot enter status blocked without naming its blocker"; 3 rows by 20:51Z) and never
--    reached agent review. The capture policy stamps payload.implementationReadiness.reason =
--    'awaiting-agent-review' BEFORE the park, and an enrolled review lives in
--    payload.agentReview.status. Both now count. Recognising it here, rather than only in the
--    caller, also fixes the release still serving :3070, which cannot change until it deploys.
--
-- 2. payload.blockedReason only vouches for the write that stamped it.
--    Leader-triage stamps payload.blockedReason + payload.blockedAt and then flips the status
--    (issues-engineer.ts markLeaderTriage; resolve-core.ts routeToLeaderTriage). Nothing clears
--    the reason when the item is reopened, and a failed capture review stamps one on a row that
--    stays open. Under 1474 any such leftover reason let a later, unrelated `blocked` write through
--    with nothing named. A reason now counts only when payload.blockedAt is a timestamp from the
--    last 15 minutes (with 5 minutes of clock-skew allowance into the future). A malformed
--    blockedAt counts as absent.
--
-- Unchanged from 1474: the scope (local ordinary-queue work rows, the transition INTO blocked
-- only), the external-blocker / plan / dependency-edge rules, the error code and the hint.
-- Not destructive: CREATE OR REPLACE FUNCTION only; the 1474 trigger keeps pointing at it.
-- Rerunnable.

CREATE OR REPLACE FUNCTION harness_shared.work_item_blocked_names_blocker()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  blockers jsonb;
  blocked_at timestamptz;
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

  -- 2. a FRESH leader-triage reason (markLeaderTriage / routeToLeaderTriage stamp
  --    blockedReason + blockedAt immediately before the flip)
  IF length(btrim(COALESCE(NEW.payload ->> 'blockedReason', ''))) > 0 THEN
    BEGIN
      blocked_at := (NEW.payload ->> 'blockedAt')::timestamptz;
    EXCEPTION WHEN others THEN
      blocked_at := NULL;
    END;
    IF blocked_at IS NOT NULL
       AND blocked_at >= now() - interval '15 minutes'
       AND blocked_at <= now() + interval '5 minutes' THEN
      RETURN NEW;
    END IF;
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

  -- 5. a pending agent review (the capture review park, or an enrolled review)
  IF NEW.payload -> 'implementationReadiness' ->> 'reason' = 'awaiting-agent-review'
     OR NEW.payload -> 'agentReview' ->> 'status' IN ('pending', 'revision-requested') THEN
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
  'WI-6554700010009155 / WI-6554700010009273: a local ordinary-queue work row may only enter status blocked when it names its blocker (active payload.externalBlockers, a payload.blockedReason stamped within 15 minutes by payload.blockedAt, source_plan_slug, a work_item_deps edge, or a pending agent review).';
