-- Migration 1486 — agent_usage_samples_harness_idx covers cost_usd
-- (papercusp-performance-audit-2026-10-12 P-007, WI-6554700010009307).
--
-- WHY. The goals sync query (`goals.list`) totals portfolio spend on every
-- resolve: `portfolioSpend()` in libs/papercusp/libs/db/src/goal-pots.ts sums
-- `cost_usd` over every agent_usage_samples row of each goal-linked pot. Its
-- invalidation set includes the agent_usage_samples sweep (every model call
-- fleet-wide) and every work_items write, so it re-resolves continuously.
-- MEASURED in pg_stat_statements (window from 2026-10-09 13:43Z): 79,747 calls,
-- mean 1,125 ms, 89,743 s total, 116.7 G shared buffer touches — the largest
-- buffer consumer in the database. EXPLAIN (ANALYZE, BUFFERS) on the live table
-- (2026-10-13 02:00Z): Index Scan using agent_usage_samples_harness_idx, 1,874,529
-- rows over 3 pots, 1,852,550 shared hits, 1,250 ms. Every index tuple costs a
-- heap fetch only to read cost_usd.
--
-- WHAT. Same key, same partial predicate, plus INCLUDE (cost_usd), so the
-- portfolio and per-goal (`goalSpend`) spend reads become index-only. MEASURED on
-- an isolated temp-table replica of the same 1.87 M rows, after VACUUM ANALYZE:
-- Index Only Scan, 0 heap fetches, 438 ms (from 1,250 ms), buffer touches drop
-- from ~1.85 M to the index pages (~15 k). The live visibility map is 87.8 %
-- all-visible (relallvisible 316,334 / relpages 360,394), so the live gain is
-- slightly below the replica's. The remaining cost is aggregating 1.87 M rows,
-- not I/O; a stored rollup is the follow-up if that ever matters.
--
-- HOW. Build the covering index under a temporary name FIRST (ShareLock: readers
-- keep running, telemetry INSERTs wait for the build), then drop the old index
-- (AccessExclusive, held only from this point to commit, so readers are blocked
-- for milliseconds, not for the build), then rename the new index to the old name
-- so schema/generated.ts and every reader see the same identity. MEASURED build
-- time on the live table: ~7 s inside a rolled-back transaction (121 MB; the
-- current, bloated index is 153 MB, so this is net smaller). A plain build,
-- not CONCURRENTLY: the runner wraps each file in a transaction (same tradeoff as
-- migrations 753 and 792).
--
-- FORWARD-COMPAT: no deployed code names this index or depends on its column
-- list; the dropped index is replaced in the same transaction by one with the
-- same name, key columns, ordering and partial predicate, so every query the
-- running :3070 release issues is served at least as well before and after.
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; files >=215).

CREATE INDEX IF NOT EXISTS agent_usage_samples_harness_cov_idx
  ON harness_shared.agent_usage_samples
  USING btree (workspace_id, harness_slug, ts DESC)
  INCLUDE (cost_usd)
  WHERE (harness_slug IS NOT NULL);

DROP INDEX IF EXISTS harness_shared.agent_usage_samples_harness_idx;

ALTER INDEX harness_shared.agent_usage_samples_harness_cov_idx
  RENAME TO agent_usage_samples_harness_idx;
