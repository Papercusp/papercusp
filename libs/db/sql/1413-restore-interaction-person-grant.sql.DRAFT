-- 1413: restore the person -> record grant that migration 1395 held back from interaction sources
-- (plan crm-agent-sales-onboarding-apps-2026-10-06 P-003, decisions D-017 point 1 and D-020;
-- work item WI-10006589, follow-up of bug WI-10006570). This is the re-grant 1395 promised.
--
-- 1395 held the grant because the release then running connector-sync threw
-- data_source_harness_missing while building the record sink for a personal Google source with no
-- config.harnessSlug, and that aborted the whole sync. The D-020 fix (graph records take the
-- workspace home harness; a participant sink fault never aborts the sync) now serves where
-- connector-sync runs. Measured 2026-10-06 22:00-22:08Z: dev:pipeline_position reports bg-host
-- (b9e3e4bb3a) containsChange:true for packages/operator-core/lib/relationship-graph/participants.ts,
-- bg-host logged `[connector-sync] ... synced=1 failed=0` five times in 15 minutes, and the
-- release operator on :3070 (which lacks the fix) logged no connector-sync in 30 minutes.
--
-- Same statements as 1393, re-applied:
--   1. the gmail/gcal kind defaults carry "person":["record"] again, so a newly connected or
--      reconnected Google source gets the grant;
--   2. every existing source that routes an interaction datatype gains `record` in its `person`
--      routes, including the personal sources without config.harnessSlug that 1395 stripped.
-- Removing `person` from a source's destination_policy still revokes the grant for that source.
--
-- Additive only: no DDL, no dropped column, and no change to the function's signature.

-- (1) New sources: the kind defaults applied by trigger_sources_apply_kind_defaults on INSERT.
CREATE OR REPLACE FUNCTION harness_shared.data_source_kind_defaults(
  p_kind text,
  OUT sync_mode text,
  OUT datatype_mappings jsonb,
  OUT destination_policy jsonb)
RETURNS record
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    CASE p_kind
      WHEN 'gmail' THEN 'poll'
      WHEN 'gcal' THEN 'poll'
      WHEN 'contacts' THEN 'poll'
      WHEN 'slack' THEN 'socket'
      WHEN 'webhook' THEN 'webhook'
      ELSE 'manual'
    END,
    (CASE p_kind
      WHEN 'gmail' THEN '{"message":"email-message"}'
      WHEN 'gcal' THEN '{"event":"calendar-event"}'
      WHEN 'contacts' THEN '{"person":"contact"}'
      WHEN 'slack' THEN '{"message":"chat-message"}'
      WHEN 'webhook' THEN '{"payload":"webhook-payload"}'
      ELSE '{}'
    END)::jsonb,
    (CASE p_kind
      WHEN 'gmail' THEN '{"email-message":["document","event"],"person":["record"]}'
      WHEN 'gcal' THEN '{"calendar-event":["document","event"],"person":["record"]}'
      WHEN 'contacts' THEN '{"contact":["document","event"]}'
      WHEN 'slack' THEN '{"chat-message":["document","event"]}'
      WHEN 'webhook' THEN '{"webhook-payload":["event"]}'
      ELSE '{}'
    END)::jsonb
$$;

-- (2) Existing sources: keyed on the policy, not on `kind`, so a source of any kind that carries
--     mail or meetings is covered; any other person routes a source already had are kept.
UPDATE harness_shared.data_sources AS s
   SET destination_policy = s.destination_policy || jsonb_build_object(
         'person',
         (SELECT jsonb_agg(DISTINCT r.route ORDER BY r.route)
            FROM jsonb_array_elements_text(
                   coalesce(s.destination_policy -> 'person', '[]'::jsonb) || '["record"]'::jsonb) AS r(route))),
       updated_at = now()
 WHERE s.destination_policy ?| ARRAY['email-message', 'calendar-event']
   AND NOT (coalesce(s.destination_policy -> 'person', '[]'::jsonb) @> '["record"]'::jsonb);
