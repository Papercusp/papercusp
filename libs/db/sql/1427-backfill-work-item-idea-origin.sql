-- 1427: backfill payload.ideaOrigin on work-items routed from an ideation origin.
--
-- Plan scout-su-ideate-pipeline-gaps-2026-10-08 P-005 (R-10/R-11), WI-10007500,
-- EI-18697923246606437. The claim-spec `item_class` field classifies a work-item as
-- 'ideation' when payload.sourceRole = 'Scout' OR payload.ideaOrigin is present
-- (packages/operator-core/lib/scout/ideation-origin.ts). recordRoutedIdea stamps
-- ideaOrigin on every NEW wi: routing from scout / su-ideate / dream; this migration
-- stamps the rows routed before that writer existed. Measured 2026-10-08 on the live
-- papercusp workspace: 959 scout + 301 su-ideate wi: refs; every su-ideate one lacks a
-- sourceRole, so without this they would classify as 'work'.
--
-- Additive and write-once: only rows with no ideaOrigin are touched, an existing stamp
-- is never overwritten, and the key is ignored by every reader except item_class.
-- When an item was routed more than once, the EARLIEST ideation routing names it.
-- agent-review / drill / shadow-variant rows are excluded: routed-ledger.ts documents
-- agent-review as intake queue plumbing, not an ideation pass.

UPDATE harness_shared.work_items AS w
   SET payload = COALESCE(w.payload, '{}'::jsonb) || jsonb_build_object('ideaOrigin', r.origin)
  FROM (
    SELECT DISTINCT ON (workspace_id, routed_ref) workspace_id, routed_ref, origin
      FROM harness_shared.scout_routed_ideas
     WHERE origin IN ('scout', 'su-ideate', 'dream')
       AND routed_ref LIKE 'wi:%'
     ORDER BY workspace_id, routed_ref, routed_at ASC
  ) AS r
 WHERE w.workspace_id = r.workspace_id
   AND w.feature_id = substr(r.routed_ref, 4)
   AND (w.payload IS NULL OR w.payload->>'ideaOrigin' IS NULL);
