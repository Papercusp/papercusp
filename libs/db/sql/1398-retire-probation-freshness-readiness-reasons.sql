-- 1398: retire the probation and freshness readiness hold reasons (plan
-- unified-bug-pipeline-and-honest-queue-2026-10-05 P-008 / D-038, WI-10006222).
--
-- Two `unknown` readiness reasons held a row out of self-select without ever handing it
-- to a clearer (EI-25176539351759672):
--   * corroborated-tool-failure-awaiting-review -- a promoted tool failure (the probation)
--   * deployment-freshness-unknown              -- a triage place whose deployment screen
--                                                  could not answer
-- P-008 retires both as hold reasons. Their writers now stamp the one stage reason,
-- awaiting-agent-review (capture-core promotedProbationReadiness, triage-core
-- triageImplementationReadiness), and the hold-registry entries for the two old reasons
-- are removed in the same change, so no writer can produce them again.
--
-- This rewrites every NON-TERMINAL row still carrying one of them. The readiness keeps
-- its status ('unknown'), source and evidence; only the reason changes, and updatedAt is
-- re-stamped. The prior readiness object is appended, unchanged, to
-- payload.implementationReadinessHistory so the original reason stays auditable.
--
-- Claimability is unchanged: the claim floor (intakeStageClaimFloorSql) holds an unknown
-- readiness out of self-select regardless of its reason. What changes is who clears it:
-- an awaiting-agent-review row with no agentReview record is stranded by definition
-- (capture-core STRANDED_REVIEW_REASONS), so the P-003 stranded sweep enrols it in agent
-- review on its next tick.
--
-- Terminal rows are history and are left as they are. Idempotent: a second run matches
-- no rows. Measured 2026-10-06 12:30Z on the dev DB: 30 non-terminal rows, all with
-- readiness status 'unknown'.

UPDATE harness_shared.work_items
   SET payload = jsonb_set(
         jsonb_set(
           payload,
           '{implementationReadinessHistory}',
           CASE jsonb_typeof(payload -> 'implementationReadinessHistory')
             WHEN 'array' THEN payload -> 'implementationReadinessHistory'
             ELSE '[]'::jsonb
           END
           || jsonb_build_array(
                (payload -> 'implementationReadiness')
                || jsonb_build_object(
                     'retiredBy', '1398-retire-probation-freshness-readiness-reasons',
                     'retiredAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                   )
              )
         ),
         '{implementationReadiness}',
         (payload -> 'implementationReadiness')
         || jsonb_build_object(
              'reason', 'awaiting-agent-review',
              'updatedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
       ),
       updated_ts = greatest(updated_ts, (extract(epoch FROM now()) * 1000)::bigint)
 -- ALL_TERMINAL_STATUSES (packages/operator-core/lib/work-item-blocking.ts):
 -- frontier-readiness TERMINAL_STATUSES ∪ ISSUE_TERMINAL_STATUSES.
 WHERE status NOT IN ('passed', 'deprecated', 'done', 'dropped', 'resolved', 'closed')
   AND jsonb_typeof(payload -> 'implementationReadiness') = 'object'
   AND payload -> 'implementationReadiness' ->> 'status' = 'unknown'
   AND payload -> 'implementationReadiness' ->> 'reason' IN (
         'corroborated-tool-failure-awaiting-review',
         'deployment-freshness-unknown'
       );
