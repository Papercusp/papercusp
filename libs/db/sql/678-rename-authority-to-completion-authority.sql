-- 678-rename-authority-to-completion-authority.sql
--
-- agent-protocol-authority-semantics-2026-07-26 P-003, follow-up to 677. See D-009.
--
-- WHY --------------------------------------------------------------------------
-- 677 added `work_items.authority`. That name is already taken, by a DIFFERENT axis:
--
--   plan items carry `authority: 'system' | 'owner'` (libs/generic/plan-parser,
--   risk-model.ts / effective-status.ts) meaning WHO IS AUTHORIZED TO ACT — and
--   `authority: 'owner'` ALWAYS derives needsHuman, armed or not (P-011).
--
--   677's column means something else entirely: HOW TRUSTWORTHY A TERMINAL CLAIM IS
--   (proposed | validated | committed | pending_human | invalid).
--
-- Two different axes under one word would be survivable if they lived apart. They do
-- not: a plan item and its promoted work-item are the same thing to an agent, which
-- reads `authority: system` off `plans:items` and would read `authority: committed`
-- off `work_items:get` in the same breath.
--
-- And they collide precisely where a mistake costs most. BOTH axes carry a
-- human-attention value — `owner` on one, `pending_human` on the other — so the
-- natural (wrong) inference is that they are one axis with a shared meaning. An agent
-- that concludes `pending_human` is just the work-item spelling of `authority: owner`
-- will treat an under-evidenced completion as an owner-gated item and wait for a
-- ratification nobody owes it.
--
-- This plan exists to remove exactly this class of ambiguity from the agent protocol
-- (D-004: load-bearing commitments belong in the harness, stated unambiguously). It
-- cannot ship a homograph on the needs-human boundary as its own central mechanism.
--
-- `completion_authority` keeps the plan's concept intact — this is still the authority
-- axis, and D-003/D-007/D-008 still read correctly — while saying what it is the
-- authority OF.
--
-- WHY NOW: nothing reads or writes the column yet. 677 landed minutes ago and P-004
-- (the first writer) has not started, so the rename costs one migration and touches no
-- caller. Every later phase makes it more expensive.
--
-- 677 is deliberately left as-applied rather than edited: it is recorded in
-- schema_migrations with its file hash, and rewriting an applied migration is how a
-- drift check starts reporting a schema that no longer matches its own history.

-- Same reader-order lock preamble as 677, and for the same reason: this touches the
-- base table and both dependent views in one transaction, and readers acquire
-- view-then-base. Acquiring in the opposite order deadlocked 677's first apply.
LOCK TABLE harness_shared.engineer_issues,
           harness_shared.harness_features_consolidated,
           harness_shared.work_items
  IN ACCESS EXCLUSIVE MODE;

-- ── 1. rename the column (guarded so re-application is a no-op) ────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'harness_shared' AND table_name = 'work_items' AND column_name = 'authority'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'harness_shared' AND table_name = 'work_items' AND column_name = 'completion_authority'
  ) THEN
    ALTER TABLE harness_shared.work_items RENAME COLUMN authority TO completion_authority;
  END IF;
END $$;

COMMENT ON COLUMN harness_shared.work_items.completion_authority IS
  'Completion-authority axis (plan agent-protocol-authority-semantics-2026-07-26 P-003): '
  'how trustworthy the terminal CLAIM on this row is, orthogonal to lifecycle `status`. '
  'proposed|validated|committed|pending_human|invalid. NOT the plan-item `authority` axis '
  '(system|owner = who may act) — see D-009. NULL on a non-terminal row means "owes no claim '
  'yet"; NULL on a TERMINAL row means a legacy pre-authority close, which counts toward '
  'burn-down and is never nagged or reclassified (D-005/D-008). Only committed and validated '
  'count toward burn-down.';

-- ── 2. rename the constraint + indexes to match ────────────────────────────────
-- A RENAME COLUMN carries the constraint and indexes across intact, but leaves them
-- named after the old column — which is how a schema ends up with a
-- `work_items_authority_check` guarding `completion_authority` and nobody able to find it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_items_authority_check'
             AND conrelid = 'harness_shared.work_items'::regclass) THEN
    ALTER TABLE harness_shared.work_items
      RENAME CONSTRAINT work_items_authority_check TO work_items_completion_authority_check;
  END IF;
END $$;

ALTER INDEX IF EXISTS harness_shared.work_items_authority_idx
  RENAME TO work_items_completion_authority_idx;
ALTER INDEX IF EXISTS harness_shared.work_items_authority_proposed_idx
  RENAME TO work_items_completion_authority_proposed_idx;

-- ── 3. re-point both family views at the renamed column ────────────────────────
-- CREATE OR REPLACE cannot RENAME an existing view column, so these are DROP + CREATE.
-- Safe here because 677 shipped minutes ago and nothing has been built on the column;
-- both bodies are 677's verbatim, with the trailing column renamed.
DROP VIEW IF EXISTS harness_shared.harness_features_consolidated;
CREATE VIEW harness_shared.harness_features_consolidated AS
  SELECT harness_slug, feature_id, title, summary, status, attempts, claims, notes, metadata,
    kind, project_id, expected_cost_cents, tags, needs_human_review, ts, created_ts, updated_ts,
    parent_id, goal_id, taken_by, taken_at, expires_at, workspace_id, _search, deprecation_reason,
    see_also, needs_design, design_status, design_spec_id, discarded_design_work, completion_ref,
    created_by_github_user_id, working_users, worked_by_history, verified_done_at_remote_ts,
    verifier_last_error, verifier_last_checked_at, source_plan_slug, source_plan_item_ids, wave,
    feature_order, author_pubkey, origin, audit_verdict, audit_reasons, audited_at, item_kind,
    payload, assignee_rank, rank_writer, rank_updated_at, fed_ts, swarm_affinity, redundancy,
    verified_author_github_user_id, schedule, schedule_active, scheduled_at, tzid, template_slug,
    run_seq, requeue_count, fed_hlc, last_progress_at, terminal_owner, terminal_completion_ref,
    last_released_by, last_released_at, embedding, embedding_mode, terminal_reason,
    completion_authority
   FROM harness_shared.work_items
  WHERE item_kind <> ALL (ARRAY['bug'::text, 'change'::text, 'task'::text]);

DROP VIEW IF EXISTS harness_shared.engineer_issues;
CREATE VIEW harness_shared.engineer_issues AS
  SELECT workspace_id,
    feature_id AS issue_id,
        CASE
            WHEN harness_slug ~~ 'operator:%'::text OR harness_slug = ''::text THEN 'operator'::text
            ELSE 'harness:'::text || harness_slug
        END AS scope,
    title,
    COALESCE(summary, ''::text) AS body,
    COALESCE((payload -> '_ei'::text) ->> 'severity'::text, 'minor'::text) AS severity,
    COALESCE((payload -> '_ei'::text) ->> 'source'::text, 'engineer'::text) AS source,
    status AS state,
    taken_by AS assignee,
    (payload -> '_ei'::text) ->> 'found_during'::text AS found_during,
    (payload -> '_ei'::text) ->> 'linked_feature_id'::text AS linked_feature_id,
    (payload -> '_ei'::text) ->> 'created_by'::text AS created_by,
    to_timestamp((created_ts::numeric / 1000.0)::double precision) AS created_at,
    to_timestamp((updated_ts::numeric / 1000.0)::double precision) AS updated_at,
    author_pubkey,
    origin,
    _search,
    item_kind AS kind,
    payload - '_ei'::text AS payload,
    (payload -> '_ei'::text) ->> 'assigned_by'::text AS assigned_by,
    taken_at AS assigned_at,
    assignee_rank,
    rank_writer,
    rank_updated_at,
    fed_ts,
    COALESCE((payload -> '_ei'::text) ->> 'signal_origin'::text, 'organic'::text) AS signal_origin,
    fed_hlc,
    terminal_owner,
    terminal_completion_ref,
    last_progress_at,
    harness_slug AS base_harness_slug,
    origin AS base_origin,
    feature_order,
    terminal_reason,
    completion_authority
   FROM harness_shared.work_items
  WHERE item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text]);
