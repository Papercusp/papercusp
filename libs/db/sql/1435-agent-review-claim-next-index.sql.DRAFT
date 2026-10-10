-- 1435 — EI-25555666233005302: bound pending-review candidate lookup work.
--
-- The claim-next query previously filtered the 3.8 GB work_items table through
-- hfc_status_idx, then read payload->agentReview and sorted eligible rows by a
-- correlated reporter count. Invocation metadata measured candidateLookup at
-- 177.7s for a 55s MCP call. The STORED projection already mirrors that payload
-- subdocument; this partial index narrows the scan to open, unclaimed review rows
-- and supplies the leading feature_order key for incremental sorting.
CREATE INDEX IF NOT EXISTS work_items_agent_review_claim_next_idx
  ON harness_shared.work_items
    (workspace_id, harness_slug, feature_order ASC NULLS LAST, created_ts ASC, feature_id)
 WHERE status = 'open'
   AND item_kind IN ('bug', 'change', 'task', 'feature')
   AND (taken_by IS NULL OR btrim(taken_by) = '')
   AND agent_review_projection ->> 'status' = 'pending';
