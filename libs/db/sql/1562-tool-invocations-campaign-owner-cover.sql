-- 1562 — cover the exact owner/time window used by fleet campaign speaking reads.
-- WI-6554700010017901 reproduced two staged leader-brief campaign timeouts.
-- The speaking axis aggregates tool_invocations by fleet ever-members, workspace,
-- invocation boundary, and optional harness; its per-owner evidence also reads
-- status. pg_stat_statements measured the existing owner/time aggregate at an
-- 18.6s mean across 884 calls, while EXPLAIN showed workspace and harness left as
-- heap filters on tool_invocations_coord_owner_idx. This covering access path
-- keeps those rows and all projected values on the index.
--
-- The migration runner wraps each file in a transaction, so this uses ordinary
-- CREATE INDEX. On a large live table, pre-build this exact definition with
-- CREATE INDEX CONCURRENTLY before applying; IF NOT EXISTS makes the migration
-- a no-op after that online build.

CREATE INDEX IF NOT EXISTS tool_invocations_campaign_owner_cover_idx
  ON harness_shared.tool_invocations (workspace_id, coord_owner_id, invoked_at DESC)
  INCLUDE (harness_slug, status)
  WHERE coord_owner_id IS NOT NULL;

COMMENT ON INDEX harness_shared.tool_invocations_campaign_owner_cover_idx IS
  'fleet campaign speaking axis: workspace + ever-member owner + boundary, covering harness and status';
