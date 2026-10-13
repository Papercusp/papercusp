-- Migration 1487 — newest-row indexes for presence wakeability; keep the
-- 1486 spend index index-only (papercusp-performance-audit-2026-10-12 P-007,
-- WI-6554700010009307).
--
-- 1. agent_activity (owner_id, created_at DESC) and its lifecycle-only partial
--    twin. fetchWakeability (packages/operator-core/lib/agent-tools/
--    coordination/presence-wakeability.ts) asks, per roster owner, for the
--    newest activity row and the newest session-end marker in a 7-day window.
--    Behind every presence / roster / fleet:assignments / delivery-ladder read.
--    MEASURED (pg_stat_statements queryid -6971270639173727676): 1,356,409
--    calls since 2026-10-09 at 61.9 ms; a 90 s interval at 2026-10-13 02:10Z
--    saw 313 calls at 76 ms and 33 k buffers each. The old GROUP BY form, with
--    only (owner_id, id) and (created_at) to choose from, walked every row each
--    owner wrote in the window: for a 300-owner roster 112,553 rows, 116,604
--    buffers, 162 ms. With these indexes the code now does two LIMIT 1
--    descents per owner: 42 ms for the same roster on a replica of the last
--    8 days (1.18 M rows), result set identical (EXCEPT both ways = 0 rows).
--    Build MEASURED on the live table inside a rolled-back transaction:
--    2.1 s + 0.25 s (ShareLock: activity INSERTs wait, readers do not).
--
-- 2. agent_usage_samples autovacuum_vacuum_insert_scale_factor 0.01. Migration
--    1486 made the goal spend reads index-only, but an index-only scan still
--    visits the heap for every page the visibility map does not mark
--    all-visible. This append-heavy table waits for the default 20 % growth
--    before an insert-triggered vacuum: MEASURED after 1486 applied, 76 % of
--    pages all-visible, 509,688 heap fetches of 1.87 M rows, 777 ms (vs
--    ~440 ms with a current map). 1 % of ~2.2 M rows is ~22 k inserts between
--    vacuums. A storage parameter: ShareUpdateExclusiveLock, blocks nothing.
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; files >=215).

CREATE INDEX IF NOT EXISTS agent_activity_owner_created_idx
  ON harness_shared.agent_activity
  USING btree (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS agent_activity_owner_lifecycle_idx
  ON harness_shared.agent_activity
  USING btree (owner_id, created_at DESC)
  WHERE (kind = 'lifecycle');

ALTER TABLE harness_shared.agent_usage_samples
  SET (autovacuum_vacuum_insert_scale_factor = 0.01);
