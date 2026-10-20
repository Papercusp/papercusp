-- Migration 1539 — index the two "which items wait on this event key" lookups
-- (plan event-wait-settlement-2026-10-20 P-002, work item WI-6554700010018154).
--
-- WHY. Every announced-event settlement runs two lookups inside its transaction,
-- with `FOR UPDATE`:
--   * reconcileEventExternalBlockers (work-items.ts) — items whose payload carries an
--     ACTIVE `{kind:'event', ref:<key>}` external blocker;
--   * reconcileEventDurableParks (work-items-durable-park-audit.ts) — unclaimed items
--     whose durable claim park names `<key>` as its release trigger.
-- MEASURED 2026-10-20 ~14:55Z on papercusp-workspace (404,825 rows, 694 MB heap):
--   * external blockers: Index Scan on work_items_external_blockers_ws_idx (migration
--     1475) — that index only narrows to the 4,431 rows that ever carried a blocker, then
--     filters each payload: 89.7 ms, 25,429 shared buffers, 4,426 rows removed, 0 returned;
--   * durable parks: Parallel Seq Scan, 676.6 ms, 930,107 shared buffers, to return 0
--     rows (1,018 rows carry `claim_hold_release`).
--
-- WHAT. Two partial expression indexes the rewritten queries match exactly:
--   * a GIN jsonb_path_ops index on `payload -> 'externalBlockers'`, partial on
--     `payload ? 'externalBlockers'`, serving
--     `payload -> 'externalBlockers' @> '[{"kind":"event","ref":<key>,"status":"active"}]'`;
--   * a btree on `payload -> 'claim_hold_release' ->> 'trigger'`, partial on
--     `payload ? 'claim_hold_release'`, serving the trigger equality.
-- Both partial sets grow only with rows that ever carried a blocker / a durable park,
-- not with the table. 1475's btree stays: the work-item-ref auto-clear still uses it.
--
-- Additive only: no DROP, no rename, no constraint. The currently-deployed release does
-- not reference these indexes and keeps working unchanged against them.
CREATE INDEX IF NOT EXISTS work_items_external_blockers_gin_idx
  ON harness_shared.work_items
  USING gin ((payload -> 'externalBlockers') jsonb_path_ops)
  WHERE (payload ? 'externalBlockers');

CREATE INDEX IF NOT EXISTS work_items_claim_hold_release_trigger_idx
  ON harness_shared.work_items
  USING btree (((payload -> 'claim_hold_release') ->> 'trigger'))
  WHERE (payload ? 'claim_hold_release');
