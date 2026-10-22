-- WI-6554700010020092: source-only conformance work must honor existing
-- direct-route decisions, just as payload.plan_item work does. Keep the prior
-- lifecycle/lease/dependency floors intact and preserve payload lane authority.
-- Twin: reservedPlanLaneExclusionSql; bound by claim-ssot-agreement integration.
-- FORWARD-COMPAT: preserve the public nine-argument signature and return type.
-- Existing deployed callers and the twelve-argument overload keep calling it.
DO $guard1556$
BEGIN
  IF to_regprocedure(
    'harness_shared.work_item_claim_floors_pre1556(text,text,text,text,text,text,text,jsonb,text)'
  ) IS NULL THEN
    ALTER FUNCTION harness_shared.work_item_claim_floors(
      text, text, text, text, text, text, text, jsonb, text
    ) RENAME TO work_item_claim_floors_pre1556;
  END IF;
END
$guard1556$;

CREATE OR REPLACE FUNCTION harness_shared.work_item_claim_floors(
  p_workspace_id text, p_status text, p_taken_by text, p_origin text,
  p_title text, p_terminal_owner text, p_terminal_completion_ref text,
  p_payload jsonb, p_feature_id text
) RETURNS text[]
LANGUAGE sql STABLE
AS $floor1556$
  SELECT CASE WHEN NOT ('reserved-plan-lane' = ANY(prior.labels))
    AND NULLIF(btrim(p_payload->'plan_item'->>'plan_slug'), '') IS NULL
    AND EXISTS (
      SELECT 1
        FROM harness_shared.work_items candidate
        JOIN harness_shared.plan_decisions d
          ON d.workspace_id = candidate.workspace_id
         AND d.plan_slug = NULLIF(btrim(candidate.source_plan_slug), '')
       WHERE candidate.workspace_id = p_workspace_id
         AND candidate.feature_id = p_feature_id
         AND (
           (
             (cardinality(COALESCE(d.item_refs, ARRAY[]::text[])) = 0
               OR COALESCE(d.item_refs, ARRAY[]::text[])
                 && COALESCE(candidate.source_plan_item_ids, ARRAY[]::text[]))
             AND (
               LOWER(d.title) LIKE '%self-only execution route%'
               OR (LOWER(BTRIM(d.title)) = 'direct execution route' AND (
                 LOWER(d.body) LIKE '%implements the plan directly%'
                 OR LOWER(d.body) LIKE '%implement it itself%'
                 OR LOWER(d.body) LIKE '%no fleet%'
                 OR LOWER(d.body) LIKE '%no subagents%'
               ))
               OR LOWER(d.body) ~ '(^|[^a-z0-9_-])su-[a-f0-9-]{8,36} is the (single|sole) implementer([[:space:].;]|$)'
               OR LOWER(d.body) ~ '(^|[^a-z0-9_-])route is this session implementing directly, without (a new )?fleet([[:space:].;]|$)'
             )
           )
           OR LOWER(d.body) ~ '(^|[^a-z0-9_-])route[[:space:]]+a:[[:space:]]+this session[[:space:]]+[(]su-[a-f0-9-]{8,36}[)][[:space:]]+implements the plan([[:space:].;]|$)'
         )
    ) THEN array_append(prior.labels, 'reserved-plan-lane'::text)
    ELSE prior.labels END
    FROM (SELECT harness_shared.work_item_claim_floors_pre1556(
      p_workspace_id, p_status, p_taken_by, p_origin, p_title,
      p_terminal_owner, p_terminal_completion_ref, p_payload, p_feature_id
    ) AS labels) prior
$floor1556$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(text,text,text,text,text,text,text,jsonb,text) IS
  'Existing claim floors plus source-only direct-route reservations (WI20092). Same workspace and itemRefs scope; no invented source item. Payload-linked authority and deliberate by-ID claims remain unchanged.';
