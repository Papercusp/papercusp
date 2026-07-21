-- Migration 654 — P-001 (work-item-claimability-clarity-2026-07-20): a QUERYABLE SQL SSOT for
-- issue-family claim floors, so a raw dev:pg_query / admissibleOnly read AGREES with what
-- scheduler:get_next / work_items:claim_next actually serves.
--
-- THE GAP (owner turn-45, "claimability not queryable = the actual bug") ---------------------
-- The claim floors live ONLY as TS sql-tagged fragments (issueAdmissibleWhereSql + the WHERE
-- chain of claimNextIssueWorkItem in packages/operator-core/lib/work-items.ts). There is NO SQL
-- object a human/agent can query, so a raw "what is claimable?" read hand-rolls floors that
-- DIVERGE from the scheduler — the root of the 2026-07-12 idle-fleet incident (a leader fed a
-- tranche `admissibleOnly:true` reported as claimable that scheduler:get_next correctly refused).
-- This migration lands the missing SSOT:
--   * harness_shared.work_item_claim_floors(...)  -> text[] of the VIOLATED floor labels
--                                                    (empty array = claimable)
--   * harness_shared.work_items_claimable          -> the issue-family rows the floors admit
--
-- SCOPE: the ISSUE family (bug|change|task) — the incident, `admissibleOnly`, and the P-005
-- re-admit backlog are all issue-family. The floors encoded are the UNCONDITIONAL (caller-
-- independent) ones claimNextIssueWorkItem ANDs in. The PER-CLAIM floors — cross-machine-rig
-- (rigAvailable), swarm-affinity (swarmId), redundancy (excludeRedundant), release-cooldown
-- (the caller's own recent release) — are deliberately OMITTED: they depend on the CLAIMING
-- caller's capability/spec, not the row, so a generic "claimable by someone" predicate cannot
-- bake them in. Feature-family floors (trust-admission + placement-kind, both flag-gated) are a
-- documented follow-up. P-002 refactors the TS claim/admissible paths to CALL this SSOT so the
-- two can never drift again.
--
-- Idempotent: CREATE OR REPLACE for both objects. STABLE (reads tables + now(), never writes).

CREATE OR REPLACE FUNCTION harness_shared.work_item_claim_floors(
  p_status                  text,
  p_taken_by                text,
  p_origin                  text,
  p_author_pubkey           text,
  p_title                   text,
  p_terminal_owner          text,
  p_terminal_completion_ref text,
  p_payload                 jsonb,
  p_workspace_id            text,
  p_feature_id              text
) RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  -- One label per VIOLATED floor; array_remove drops the NULLs (satisfied floors), so an
  -- all-satisfied row returns '{}' (= claimable). Order mirrors claimNextIssueWorkItem.
  SELECT array_remove(ARRAY[
    -- 1. claimable status = 'open' (ISSUE_FAMILY_CLAIMABLE_STATES) — terminal/blocked/wip excluded.
    CASE WHEN p_status IS DISTINCT FROM 'open' THEN 'not-open' END,
    -- 2. unclaimed — taken_by null / blank / 'unassigned'.
    CASE WHEN NOT (p_taken_by IS NULL OR btrim(p_taken_by) = '' OR lower(btrim(p_taken_by)) = 'unassigned')
         THEN 'taken' END,
    -- 3. locally claimable, own-node aware (isIssueLocallyClaimableWhereSql): origin local/null, OR
    --    a remote row whose author_pubkey is one THIS workspace has ALSO written locally (identity
    --    round-tripped federation / drifted substrate key — our own log proves we authored it).
    CASE WHEN NOT (
           p_origin IS NULL OR p_origin = 'local'
           OR (p_author_pubkey IS NOT NULL AND p_author_pubkey <> '' AND p_author_pubkey IN (
                 SELECT own.author_pubkey FROM harness_shared.work_items own
                  WHERE own.workspace_id = p_workspace_id
                    AND (own.origin = 'local' OR own.origin IS NULL)
                    AND own.author_pubkey IS NOT NULL AND own.author_pubkey <> ''))
         ) THEN 'federated-remote' END,
    -- 4. claim-hold (payload._claimHold) — a peer parked it out of self-select (still claimable BY ID).
    CASE WHEN COALESCE(p_payload, '{}'::jsonb) ->> '_claimHold' = 'true' THEN 'claim-hold' END,
    -- 5. observation-lane (D-005) — a reflection/scorecard that "never enters the work queue".
    CASE WHEN COALESCE(p_payload, '{}'::jsonb) ->> 'lane' = 'observation' THEN 'observation-lane' END,
    -- 6. needsHuman (EI-7776) — improvements:resolve routed it to a human (owner inbox), not the pool.
    CASE WHEN COALESCE(p_payload, '{}'::jsonb) ->> 'needsHuman' = 'true' THEN 'needs-human' END,
    -- 7. active typed external blocker (queue gate).
    CASE WHEN jsonb_path_exists(COALESCE(p_payload, '{}'::jsonb),
                                '$.externalBlockers[*] ? (@.status == "active")'::jsonpath)
         THEN 'external-blocker' END,
    -- 8. federation-liveness detector EI (WI-2633) — a generic drainer structurally can't action it.
    CASE WHEN COALESCE(p_payload, '{}'::jsonb) #>> '{_ei,created_by}' = 'system:replication-liveness'
         THEN 'federation-detector' END,
    -- 9. loop-iteration bookkeeping noise (EI-8802) — a misfiled loop:checkpoint marker.
    CASE WHEN COALESCE(p_title, '') ILIKE 'Loop wake #%' OR COALESCE(p_title, '') ILIKE 'AUTO loop iteration:%'
         THEN 'loop-iteration-noise' END,
    -- 10. already terminally completed (EI-8972) — terminal_owner + ref set even though `status` was
    --     never flipped terminal; a peer already finished/diagnosed it.
    CASE WHEN (p_terminal_owner IS NOT NULL AND p_terminal_owner <> '')
          AND (p_terminal_completion_ref IS NOT NULL AND p_terminal_completion_ref <> '')
         THEN 'already-terminally-completed' END,
    -- 11. reserved to another ACTIVE plan lane / a LIVE plan_item_claims lease. No owner-exemption:
    --     a generic "claimable by anyone" read; the claiming agent's own-lease exemption is caller-context.
    CASE WHEN COALESCE(p_payload, '{}'::jsonb) ? 'plan_item' AND (
           EXISTS (SELECT 1 FROM harness_shared.harness_plans hp
                    WHERE hp.plan_slug = p_payload->'plan_item'->>'plan_slug' AND hp.status = 'active')
           OR EXISTS (SELECT 1 FROM harness_shared.plan_item_claims pic
                       WHERE pic.plan_slug = p_payload->'plan_item'->>'plan_slug'
                         AND pic.item_id  = p_payload->'plan_item'->>'item_id'
                         AND pic.expires_ts > now())
         ) THEN 'reserved-plan-lane' END,
    -- 12. readiness — a PRESENT, NON-TERMINAL blocker (work_item_deps, dep_type='blocks'). The issue
    --     blocked_ref is the BARE feature_id; a blocker is SATISFIED iff terminal or absent.
    CASE WHEN EXISTS (
           SELECT 1 FROM harness_shared.work_item_deps d
            WHERE d.workspace_id = 'default' AND d.dep_type = 'blocks' AND d.blocked_ref = p_feature_id
              AND (EXISTS (SELECT 1 FROM harness_shared.harness_features_consolidated bf
                            WHERE (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
                              AND bf.status NOT IN ('passed','deprecated','done','dropped'))
                OR EXISTS (SELECT 1 FROM harness_shared.engineer_issues bi
                            WHERE bi.workspace_id = 'default' AND bi.issue_id = d.blocker_ref
                              AND bi.state NOT IN ('resolved','closed','done','dropped')))
         ) THEN 'blocked-dep' END
  ], NULL)
$$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(text, text, text, text, text, text, text, jsonb, text, text) IS
  'P-001 (work-item-claimability-clarity): the UNCONDITIONAL issue-family claim floors as a queryable SSOT. Returns the VIOLATED floor labels (empty = claimable). Mirrors claimNextIssueWorkItem''s caller-independent floors; per-claim floors (rig/swarm/redundancy/cooldown) are caller-context and intentionally excluded. P-002 will make the TS claim/admissible paths call this so they never drift.';

CREATE OR REPLACE VIEW harness_shared.work_items_claimable AS
  SELECT wi.*
    FROM harness_shared.work_items wi
   WHERE wi.item_kind IN ('bug', 'change', 'task')
     AND cardinality(harness_shared.work_item_claim_floors(
           wi.status, wi.taken_by, wi.origin, wi.author_pubkey, wi.title,
           wi.terminal_owner, wi.terminal_completion_ref, wi.payload, wi.workspace_id, wi.feature_id
         )) = 0;

COMMENT ON VIEW harness_shared.work_items_claimable IS
  'P-001 (work-item-claimability-clarity): issue-family (bug|change|task) rows that pass EVERY unconditional claim floor (work_item_claim_floors returns empty) — i.e. rows scheduler:get_next / claim_next would serve to a generic caller, modulo per-claim rig/swarm/redundancy/cooldown. Query this instead of hand-rolling floors in raw SQL (owner turn-45).';
