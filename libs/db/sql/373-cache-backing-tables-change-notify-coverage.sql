-- 373-cache-backing-tables-change-notify-coverage.sql
--
-- caching-layer-tag-eca-2026-06-22 — P-005 (trigger-coverage audit + FIX).
--
-- WHY
-- ---
-- The authoritative set of cache-backing / synced tables is the KEYS of
-- `TABLE_TO_QUERY_NAMES` in
-- packages/operator-core/lib/sync-resolver/table-to-query-names.ts — the map the
-- sync-sse.ts LISTEN bridge uses to turn a `harness_shared.<table>.changed` event
-- into the camelCase query-name invalidations + cache-tag bumps (P-006). For that
-- bridge to fire on a write, the backing table MUST carry the generic
-- `harness_shared.emit_change_notify()` trigger (000-baseline.sql; payload fixed +
-- row-PK-carrying as of mig-368).
--
-- An exhaustive audit (2026-06-22, su-6ef65, live operator pg_query) found that 34
-- of the 48 mapped tables LACK that trigger. They relied SOLELY on app-code
-- `notifySyncInvalidate(...)`, which (a) is source-deduped 90s per (name,args) so a
-- second change inside the window is swallowed, and (b) is bypassed entirely by
-- raw-SQL and FEDERATED writes (federation sync-apply writes via INSERT ON CONFLICT
-- and depends on the LOCAL trigger to invalidate — D-005). So a federated/raw write
-- to any of these 34 left every node's sync cache silently stale. The plan item
-- spot-checked only hive_members + hive_settings; the real gap is the whole class.
--
-- FIX
-- ---
-- Attach the generic change-notify trigger to all 34 missing tables, matching the
-- established per-table pattern (mig 107 / 124 / 222). The 14 already-covered tables
-- are untouched; in particular the SPECIALLY-TUNED hot triggers are NOT in this list
-- and are preserved unchanged:
--   • coord_event_log  — filtered to ORIGINAL rows (mig-275), avoids fan-out spam.
--   • spawned_agents   — column-targeted AFTER UPDATE (mig-213), avoids heartbeat spam.
-- Both already satisfy emit_change_notify coverage, so they are excluded here by
-- construction (the list is exactly the audited has_trigger=false set).
--
-- A CI guard (cache-tag-trigger-coverage.integration.test.ts) asserts every
-- TABLE_TO_QUERY_NAMES key has the trigger so this coverage can't silently drift.
--
-- Idempotent: `CREATE OR REPLACE TRIGGER` per table (PG14+), existence-guarded so a
-- table not yet created on a given branch is skipped rather than erroring.

DO $mig$
DECLARE
  t text;
  cache_backing_tables text[] := ARRAY[
    'agent_runs_consolidated',
    'audit_log',
    'feature_audit_consolidated',
    'harness_archives',
    'harness_brainstorm',
    'harness_checkpoints',
    'harness_chunk_plans',
    'harness_decisions',
    'harness_escalations',
    'harness_feature_debug_notes',
    'harness_feature_notes',
    'harness_hook_logs',
    'harness_lanes',
    'harness_pending_issues',
    'harness_project_files',
    'harness_proposals_shared',
    'harness_screenshots',
    'harness_skills',
    'harness_smoke_test',
    'harness_snapshots_consolidated',
    'harness_status',
    'harness_tests',
    'harness_text_artifacts',
    'hive_members',
    'hive_settings',
    'operator_budget',
    'pending_reviews',
    'plan_revisions',
    'plan_runs',
    'plugin_configs',
    'plugin_enables',
    'project_spec_revisions',
    'toast_log',
    'user_actions'
  ];
BEGIN
  FOREACH t IN ARRAY cache_backing_tables LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared'
         AND c.relname = t
         AND c.relkind IN ('r', 'p')  -- ordinary or partitioned table; never a view
    ) THEN
      EXECUTE format(
        'CREATE OR REPLACE TRIGGER emit_change_notify_trg '
        'AFTER INSERT OR UPDATE OR DELETE ON harness_shared.%I '
        'FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify()',
        t
      );
    END IF;
  END LOOP;
END $mig$;
