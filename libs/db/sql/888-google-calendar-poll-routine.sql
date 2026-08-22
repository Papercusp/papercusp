-- 888-google-calendar-poll-routine.sql — external triggers P-019.
--
-- The Google Calendar adapter uses the existing durable routines engine as its
-- local poll/time-wheel. Calendar push channels require a public webhook, so
-- the offline-first path deliberately polls with a persisted syncToken instead.
-- Re-applying this migration updates the routine contract without undoing an
-- operator's explicit pause.

INSERT INTO harness_shared.routines
  (id, install_slug, workspace_id, name, trigger_kind, trigger_config,
   target_role, concurrency, catchup, active, next_fire_at, tier)
VALUES
  ('rt_papercusp_google_calendar_poll', 'papercusp', 'papercusp-workspace',
   'google-calendar-poll', 'cron',
   '{"cron":"0 * * * * *","lead_minutes":15}'::jsonb,
   'system:google-calendar-poll', 'skip', 'skip-old', TRUE, now(), 'durable')
ON CONFLICT (install_slug, name) DO UPDATE SET
  workspace_id = EXCLUDED.workspace_id,
  trigger_kind = EXCLUDED.trigger_kind,
  trigger_config = EXCLUDED.trigger_config,
  target_role = EXCLUDED.target_role,
  concurrency = EXCLUDED.concurrency,
  catchup = EXCLUDED.catchup,
  tier = EXCLUDED.tier,
  active = harness_shared.routines.active,
  updated_at = now();
