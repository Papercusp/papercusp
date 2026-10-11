-- 1455 — Index the coord messages that carry an expectEffect stamp.
-- WI-6554700010008549.
--
-- WHY. packages/operator-core/lib/agent-tools/coordination/directive-effect-read.ts
-- (fetchDirectiveActuationEntries) scans coord_event_log for messages that carry
-- body.expectEffect and are addressed to a set of recipients. It runs on fleet reads
-- (assignments, unanswered-directed, reply-deadline sweep, fleet-scope admission).
-- Only about 1.7k of about 1M messages carry expectEffect, but the only usable index was
-- the GIN on body->'to' (P-014(c) restatement), which returns every message addressed
-- to ANY of the recipients. EXPLAIN ANALYZE 2026-10-11 with 60 live recipients:
-- bitmap heap scan, 24,983 rows removed by filter, 41,089 buffers, 292 ms warm, for 8
-- rows. pg_stat_statements 2026-10-09..11: about 44k calls across the two live forms,
-- mean 418-725 ms, max 36 s. The older form (still served by the release build) has no
-- recipient restatement at all and walks every message.
--
-- SHAPE. Partial on exactly the two literal predicates both query forms carry
-- (surface = 'messages' AND body ? 'expectEffect'), so it holds only stamped messages and
-- either form can use it regardless of recipient count.
--
-- LARGE EXISTING TABLES. The runner applies each file in one transaction, so this cannot
-- say CONCURRENTLY, and a plain CREATE INDEX blocks writes to coord_event_log while it
-- builds. On the dev box (about 1M message rows) the index was pre-built with CREATE INDEX
-- CONCURRENTLY on 2026-10-11, so IF NOT EXISTS makes this file a no-op there. A fresh or
-- embedded database has few rows and builds it inline in milliseconds. A host with a large
-- table and no index should pre-build the statement below with CONCURRENTLY before this
-- migration applies.
CREATE INDEX IF NOT EXISTS coord_event_log_msgs_expect_effect_idx
  ON harness_shared.coord_event_log (workspace_id)
  WHERE surface = 'messages' AND body ? 'expectEffect';
