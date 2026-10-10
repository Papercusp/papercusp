-- 1440: backfill agentReview.revisionKind = 'reproduction' on reproduction-only revisions.
--
-- Plan bug-queue-legitimacy-and-actionable-validation-2026-10-10, D-006 / D-007 (WI-10008042).
-- agent-review now stamps WHY a review was sent back: 'content' when the independent grade
-- failed, 'reproduction' when the grade PASSED and the only refusal was a missing or
-- unaccepted current-build reproduction receipt. The intake-stage claim floor admits the
-- 'reproduction' kind as validation work for the drain lane; readiness stays not-ready, so
-- no fix can start without an accepted receipt.
--
-- Rows sent back before that change carry no kind. This stamps ONLY the rows the code
-- itself would have stamped 'reproduction': open, non-observation bugs in
-- 'revision-requested' whose recorded review grade is above AGENT_REVIEW_MAX_REVISION_GRADE
-- (3). Low-grade rows are content revisions and are deliberately left untouched — a review
-- comment that MENTIONS reproduction is not proof the refusal was reproduction-only
-- (D-007's measured partition). Legacy-submitter rows already pass the floor on their own leg.
--
-- Data-only and additive: the release still serving :3070 reads agentReview through
-- readAgentReviewState, which drops unknown keys, so this changes nothing for it. The
-- agent_review_projection generated column follows the payload automatically.

UPDATE harness_shared.work_items
   SET payload = jsonb_set(payload, '{agentReview,revisionKind}', '"reproduction"'::jsonb, true)
 WHERE item_kind = 'bug'
   AND lane IS DISTINCT FROM 'observation'
   AND status NOT IN ('done', 'dropped', 'resolved', 'closed')
   AND jsonb_typeof(payload -> 'agentReview') = 'object'
   AND payload -> 'agentReview' ->> 'status' = 'revision-requested'
   AND NOT (payload -> 'agentReview' ? 'revisionKind')
   AND COALESCE(payload -> 'agentReview' ->> 'submittedBy', '') <> 'system:legacy-agent-review'
   AND (payload -> 'implementationReadiness' -> 'evidence' -> 'review' ->> 'grade') ~ '^[0-9]+$'
   AND (payload -> 'implementationReadiness' -> 'evidence' -> 'review' ->> 'grade')::int > 3;

DO $mig1440_check$
DECLARE
  unstamped integer;
BEGIN
  SELECT count(*)::int
    INTO unstamped
    FROM harness_shared.work_items
   WHERE item_kind = 'bug'
     AND lane IS DISTINCT FROM 'observation'
     AND status NOT IN ('done', 'dropped', 'resolved', 'closed')
     AND jsonb_typeof(payload -> 'agentReview') = 'object'
     AND payload -> 'agentReview' ->> 'status' = 'revision-requested'
     AND NOT (payload -> 'agentReview' ? 'revisionKind')
     AND COALESCE(payload -> 'agentReview' ->> 'submittedBy', '') <> 'system:legacy-agent-review'
     AND (payload -> 'implementationReadiness' -> 'evidence' -> 'review' ->> 'grade') ~ '^[0-9]+$'
     AND (payload -> 'implementationReadiness' -> 'evidence' -> 'review' ->> 'grade')::int > 3;

  IF unstamped <> 0 THEN
    RAISE EXCEPTION '1440: % reproduction-only revision rows remain without revisionKind', unstamped;
  END IF;
END
$mig1440_check$;
