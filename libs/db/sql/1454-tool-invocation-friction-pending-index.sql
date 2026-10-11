-- 1454 — Index the undelivered invocation-friction rows that recoverInvocationFriction reads.
-- WI-10007741 (supersedes the never-armed 1148-tool-invocation-friction-pending-index.sql.DRAFT).
--
-- WHY. packages/operator-core/lib/harness/improvements/invocation-friction.ts runs two reads on
-- every watchdog tick: recent delivery, ordered by COALESCE(frictionAttemptAt, '') then
-- invoked_at, and the expiry sweep (buildExpiredInvocationFrictionQuery), ordered by invoked_at.
-- Both filter metadata_json->>'frictionCapture' = 'pending'. That code shipped, but its indexes
-- stayed in a .DRAFT (1148) that was never armed. With no index, the expiry sweep walked
-- tool_invocations from its oldest row, filtering JSON per row. pg_stat_statements
-- 2026-10-09..11: 182 calls, mean 124 s, max 339 s, about 16M buffers per call.
--
-- SHAPE. Both indexes are partial on the pending marker, so they hold only undelivered rows and
-- stay tiny. The retry-order and expiry access paths stay separate because they sort differently.
--
-- LARGE EXISTING TABLES. The runner applies each file in one transaction, so this cannot say
-- CONCURRENTLY, and a plain CREATE INDEX blocks writes to tool_invocations while it builds. On
-- the dev box (about 6.2M rows) both indexes were pre-built with CREATE INDEX CONCURRENTLY on
-- 2026-10-11, so IF NOT EXISTS makes this file a no-op there. A fresh or embedded database has
-- few rows and builds them inline in milliseconds. A host with a large table and no index should
-- pre-build the two statements below with CONCURRENTLY before this migration applies.
CREATE INDEX IF NOT EXISTS tool_invocations_friction_pending_idx
  ON harness_shared.tool_invocations
    (workspace_id, (COALESCE(metadata_json->>'frictionAttemptAt', '')), invoked_at, id)
  WHERE metadata_json->>'frictionCapture' = 'pending';

CREATE INDEX IF NOT EXISTS tool_invocations_friction_pending_expiry_idx
  ON harness_shared.tool_invocations (workspace_id, invoked_at, id)
  WHERE metadata_json->>'frictionCapture' = 'pending';
