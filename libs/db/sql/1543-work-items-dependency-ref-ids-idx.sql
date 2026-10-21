-- Migration 1543 — index the work-item ids named by ACTIVE live-dependency blockers
-- (plan event-wait-settlement-2026-10-20 P-007, work item WI-6554700010018159).
--
-- WHY. P-007 drives the work-item-ref blocker auto-clear from the completion fire
-- `work-item:done:<id>` itself (it also fires for plan-status cascades and drops, which
-- the work_items:complete / set_state tool reactions never see). The emit asks, inside its
-- fire-latch statement, whether any non-terminal item has an active live-dependency
-- blocker naming <id>, so a completion nobody waits on costs no extra round trip.
-- Real refs never name a bare id ("work-item:WI-…", "agent-review:EI-…:round-2",
-- "<text> / WI-…"), so neither 1475's btree nor 1539's jsonb_path_ops containment can
-- answer it: the only existing form is a LIKE scan over every blocker-bearing payload.
-- MEASURED 2026-10-21 ~04:46Z on papercusp-workspace: that scan read 23,944 shared buffers
-- and took 101 ms (Index Scan on work_items_external_blockers_ws_idx, 4,478 rows removed,
-- 0 returned) — paid on every completion emit.
--
-- WHAT. An IMMUTABLE function returning the distinct work-item id tokens named by the
-- payload's active live-dependency blockers, and a partial GIN index on it. The probe is
-- `harness_shared.active_dependency_blocker_item_ids(payload) @> ARRAY[<id>]`.
-- The token pattern is a SUPERSET of WORK_ITEM_ID_TOKEN in
-- packages/operator-core/lib/work-item-ref-blocker-auto-clear.ts (no look-around): it can
-- report an id that TS would not, never miss one TS would match. A false positive costs
-- one clear transaction that changes nothing; exact matching stays in TS.
--
-- Additive only: no DROP, no rename, no constraint. The currently-deployed release does
-- not reference the function or the index and keeps working unchanged against them.
CREATE OR REPLACE FUNCTION harness_shared.active_dependency_blocker_item_ids(p jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(array_agg(DISTINCT m[1] ORDER BY m[1]), '{}'::text[])
    FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(p -> 'externalBlockers') = 'array'
                THEN p -> 'externalBlockers'
                ELSE '[]'::jsonb END
         ) AS b,
         regexp_matches(COALESCE(b ->> 'ref', ''), '((?:WI|EI|F)-[0-9]+)', 'g') AS m
   WHERE lower(COALESCE(b ->> 'status', '')) = 'active'
     AND b ->> 'capability' = 'live-dependency'
$$;

CREATE INDEX IF NOT EXISTS work_items_active_dependency_item_ids_idx
  ON harness_shared.work_items
  USING gin (harness_shared.active_dependency_blocker_item_ids(payload))
  WHERE (payload ? 'externalBlockers');
