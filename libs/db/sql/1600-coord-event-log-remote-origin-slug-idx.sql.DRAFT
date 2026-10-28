-- 1600 — Index the coord rows that arrived from a REMOTE node, by harness slug.
-- WI-6554700010030876.
--
-- WHY. packages/operator-core/lib/agent-tools/coordination/federation-scope.ts
-- (resolveWorkspaceHiveScope) picks the workspace's default federation scope. A
-- joined hive view counted as shared by definition, so a dead test join
-- (shared-hive-test-hive-2) became the lone implicit default and absorbed every
-- unscoped operator send. Measured 2026-10-28: 120,070 coord rows for that slug
-- since 2026-07-04, all origin='local', zero from a remote peer. The resolver now
-- treats a joined view as dormant unless a remote-origin coord row for its slug
-- arrived within the window. Without an index that probe is a sequential scan:
-- EXPLAIN ANALYZE 2026-10-28, 2,352,603 rows removed by filter, 355k buffers,
-- 1196 ms, and it sits on the send path when the 30 s scope cache expires.
--
-- SHAPE. Partial on origin = 'remote', so it holds only peer-authored rows (about
-- 43k of 2.3M on the dev box, 2.5 MB) and serves the EXISTS probe
-- (workspace_id, harness_slug, ts > since) as one index range lookup.
--
-- LARGE EXISTING TABLES. The runner applies each file in one transaction, so this
-- cannot say CONCURRENTLY, and a plain CREATE INDEX blocks writes to
-- coord_event_log while it builds. On the dev box the index was pre-built with
-- CREATE INDEX CONCURRENTLY on 2026-10-28 (15.8 s), so IF NOT EXISTS makes this
-- file a no-op there. A fresh or embedded database has few rows and builds it
-- inline in milliseconds. A host with a large table and no index should pre-build
-- the statement below with CONCURRENTLY before this migration applies.
CREATE INDEX IF NOT EXISTS coord_event_log_remote_origin_slug_ts_idx
  ON harness_shared.coord_event_log (workspace_id, harness_slug, ts DESC)
  WHERE origin = 'remote';
