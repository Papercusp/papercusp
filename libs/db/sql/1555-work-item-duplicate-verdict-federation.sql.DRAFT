-- EI-26637608913287256 / WI-10006055: typed duplicate verdicts must federate.
-- 1534 exposed the fields but omitted the wire projections used by stamp + capture.
-- Extend the existing helpers; null is retained to carry explicit verdict clearing.
-- No new tables, destructive operations or historical row rewrites. Older wire ops
-- remain readable; paired receivers preserve a resident verdict on legacy omission.

-- Extends 1226-feature-wire-row-drives-stamp-clock.sql.
CREATE OR REPLACE FUNCTION harness_shared.feature_wire_row(r harness_shared.work_items)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  -- Two halves: jsonb_build_object takes at most 100 arguments (FUNC_MAX_ARGS).
  -- Nulls are KEPT (no jsonb_strip_nulls): a column moving to NULL is a content change.
  SELECT jsonb_build_object(
    'workspace_id',            r.workspace_id,
    'harness_slug',            r.harness_slug,
    'feature_id',              r.feature_id,
    'title',                   r.title,
    'summary',                 r.summary,
    'status',                  r.status,
    'attempts',                r.attempts,
    'claims',                  r.claims,
    'notes',                   r.notes,
    'metadata',                r.metadata,
    'kind',                    r.kind,
    'project_id',              r.project_id,
    'expected_cost_cents',     r.expected_cost_cents,
    'tags',                    r.tags,
    'needs_human_review',      r.needs_human_review,
    'ts',                      r.ts,
    'created_ts',              r.created_ts,
    'updated_ts',              r.updated_ts,
    'parent_id',               r.parent_id,
    'goal_id',                 r.goal_id,
    'taken_by',                r.taken_by,
    'taken_at',                r.taken_at,
    'last_progress_at',        r.last_progress_at,
    'expires_at',              r.expires_at,
    'item_kind',               r.item_kind,
    'feature_order',           r.feature_order
  ) || jsonb_build_object(
    'swarm_affinity',          r.swarm_affinity,
    'redundancy',              r.redundancy,
    'payload',                 r.payload,
    'design_spec_id',          r.design_spec_id,
    'design_status',           r.design_status,
    'needs_design',            r.needs_design,
    'discarded_design_work',   r.discarded_design_work,
    'source_plan_slug',        r.source_plan_slug,
    'source_plan_item_ids',    r.source_plan_item_ids,
    'see_also',                r.see_also,
    'wave',                    r.wave,
    'deprecation_reason',      r.deprecation_reason,
    'completion_ref',          r.completion_ref,
    'terminal_owner',          r.terminal_owner,
    'terminal_completion_ref', r.terminal_completion_ref,
    'terminal_reason',         r.terminal_reason,
    'authority',               r.authority,
    'closed_ts',               r.closed_ts,
    'admission',               r.admission,
    'admitted_at',             r.admitted_at,
    'admitted_by',             r.admitted_by,
    'author_pubkey',           r.author_pubkey,
    'origin',                  r.origin,
    'fed_ts',                  r.fed_ts,
    'fed_hlc',                 r.fed_hlc,
    'verified_author_github_user_id', r.verified_author_github_user_id
  ) || jsonb_build_object(
    'duplicate_of', r.duplicate_of,
    'duplicate_source', r.duplicate_source
  )
$function$;

-- Extends 1241-engineer-issue-wire-row-preserve-payload-nulls.sql.
CREATE OR REPLACE FUNCTION harness_shared.engineer_issue_wire_row(
  r harness_shared.work_items,
  p_ws text,
  p_scope text,
  p_slug text
)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'workspace_id',      p_ws,
    'issue_id',          r.feature_id,
    'scope',             p_scope,
    'title',             r.title,
    'body',              COALESCE(r.summary, ''),
    'severity',          COALESCE(r.payload->'_ei'->>'severity', 'minor'),
    'source',            COALESCE(r.payload->'_ei'->>'source', 'engineer'),
    'state',             r.status,
    'terminal_reason',   r.terminal_reason,
    'terminal_owner',           r.terminal_owner,
    'terminal_completion_ref',  r.terminal_completion_ref,
    'authority',         r.authority,
    'closed_ts',         r.closed_ts,
    'created_ts',        r.created_ts,
    'assignee',          r.taken_by,
    'assigned_by',       r.payload->'_ei'->>'assigned_by',
    'assigned_at',       r.taken_at,
    'found_during',      r.payload->'_ei'->>'found_during',
    'linked_feature_id', r.payload->'_ei'->>'linked_feature_id',
    'created_by',        r.payload->'_ei'->>'created_by',
    'kind',              r.item_kind,
    'origin',            r.origin,
    'author_pubkey',     r.author_pubkey,
    'fed_ts',            r.fed_ts,
    'fed_hlc',           r.fed_hlc,
    'signal_origin',     COALESCE(r.payload->'_ei'->>'signal_origin', 'local'),
    'admission',            r.admission,
    'admitted_at',          r.admitted_at,
    'admitted_by',          r.admitted_by,
    'state_changed_at',     r.state_changed_at,
    'parent_id',            r.parent_id,
    'source_plan_slug',     r.source_plan_slug,
    'source_plan_item_ids', r.source_plan_item_ids,
    'expected_cost_cents',  r.expected_cost_cents,
    'harness_slug',      p_slug,
    'storage_harness_slug', r.harness_slug))
  -- Caller-owned JSON rides VERBATIM: jsonb_strip_nulls is recursive and must never
  -- reach inside it (EI-24552921468661465).
  || CASE WHEN r.payload IS NULL OR jsonb_typeof(r.payload) = 'null'
          THEN '{}'::jsonb
          ELSE jsonb_build_object('payload', r.payload - '_ei')
     END
  || CASE WHEN r.tags IS NULL OR jsonb_typeof(r.tags) = 'null'
          THEN '{}'::jsonb
          ELSE jsonb_build_object('tags', r.tags)
     END || jsonb_build_object(
    'duplicate_of', r.duplicate_of,
    'duplicate_source', r.duplicate_source
  )
$function$;
