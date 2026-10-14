-- Narrow covering index for the durable consult-answer identity edge. This
-- population is small relative to task_ledger and keeps lineage checks off its
-- wide JSONB heap/TOAST path when consult_state lacks the best-effort stamp.
CREATE INDEX IF NOT EXISTS task_ledger_consult_answer_lineage_idx
  ON harness_shared.task_ledger (
    workspace_id,
    (detail #>> '{consultAnswer,answeringOwnerId}'),
    (detail #>> '{consultAnswer,sourceOwnerId}')
  )
  WHERE detail ? 'consultAnswer'
    AND NULLIF(detail #>> '{consultAnswer,answeringOwnerId}', '') IS NOT NULL
    AND NULLIF(detail #>> '{consultAnswer,sourceOwnerId}', '') IS NOT NULL
    AND detail #>> '{consultAnswer,sourceOwnerId}'
        IS DISTINCT FROM detail #>> '{consultAnswer,answeringOwnerId}';
