-- 1444-work-items-unique-workspace-feature-id.sql
--
-- scope-unique-identifiers-2026-07-26 P-012 / WI-10008281 (decisions D-002, D-004, D-012).
--
-- A work item's identity is (workspace_id, feature_id) (D-002), but the table's
-- keys are (harness_slug, feature_id) and (workspace_id, harness_slug, feature_id),
-- so nothing stopped one id from living under two harnesses of one workspace (a
-- "twin"). Migration 1443 cleared every twin; this index makes a new one impossible:
-- any write that would mint one now fails with 23505 on
-- work_items_workspace_feature_id_uq instead of silently forking the item.
--
-- Writers (D-004): the minters were fixed in P-009 (bench ids, fixtures,
-- engineer-issues resident landing) and P-010 (node-disjoint WI- ids). The
-- hyperbee projections read the resident row before their upsert, so a peer op
-- naming an id held under another harness is landed or refused there rather
-- than reaching this index (work-items-replay-identity-indexes.ts, policy
-- 'resident-row'; otherwise the 23505 would pin the peer's merge cursor).
--
-- FORWARD-COMPAT: this index must not be applied on a node whose hyperbee
-- MERGE runtime still lacks the resident-row checks (engineer-issues P-009,
-- harness-features P-012), because that upsert would hit a deterministic 23505
-- on a twin op and pin the peer's merge cursor. Only the substrate owner runs
-- the merge: a request-only host (PAPERCUSP_BACKGROUND_WORKERS=0, e.g. the dev
-- box's :3070 and :3170) refuses the in-process substrate boot in
-- boot-all.ts defaultInProcessBootAllowed, so its code vintage does not matter
-- here (D-012 as amended by D-015). The migration ships in the same commit
-- range as both checks, so a peer gets them together, and it applies 1443 and
-- 1444 in one boot, so it never runs this against unmerged twins.
--
-- A plain (non-CONCURRENT) build: the runner applies each file in a transaction.
-- Measured 2026-10-11: 332k rows / 563 MB on papercusp-workspace's node, a
-- build of seconds that blocks writes to work_items only for its duration.

DO $$
DECLARE
  sets integer;
  sample text;
BEGIN
  SELECT count(*), min(workspace_id || '/' || feature_id)
    INTO sets, sample
    FROM (SELECT workspace_id, feature_id
            FROM harness_shared.work_items
           GROUP BY workspace_id, feature_id
          HAVING count(*) > 1) t;
  IF sets > 0 THEN
    RAISE EXCEPTION '1444: % same-workspace work-item twin set(s) remain (e.g. %); migration 1443 clears them and must run first', sets, sample;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS work_items_workspace_feature_id_uq
  ON harness_shared.work_items (workspace_id, feature_id);

COMMENT ON INDEX harness_shared.work_items_workspace_feature_id_uq IS
  'scope-unique-identifiers P-012: one row per work-item id per workspace (D-002). Replay policy: resident-row (work-items-replay-identity-indexes.ts).';
