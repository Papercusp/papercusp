-- 181-hyperbee-projection-fed-ts-guard.sql
--
-- EI-79 residual, step 2 (the correctness partner of the incremental merge
-- cursor shipped in p2p-performance-suite-2026-06-07 P-013).
--
-- The incremental merge cursor (read-merge.ts `mergeAdmittedLogsIncremental`)
-- decodes only [cursor,length) of each grown peer log per pass instead of the
-- whole history. That is only correct if applying an OLD op to a row that
-- already holds a NEWER value is a no-op at the PG layer — otherwise a late /
-- out-of-order op (a backfilling new peer, an op replicated out of order, a
-- fold rebuilt from a fresh cursor) can clobber a newer projected row. The
-- in-process `cursor.winners` fold guards this within one process lifetime, but
-- the design (EI-79 scoping: "do BOTH or neither") requires the guard to live
-- at the PG layer so each writer is last-write-wins INDEPENDENT of fold state.
--
-- The guard field is the op's WIRE ts (epoch ms) — the same field the read-merge
-- LWW (`lwwPick`) orders on (HLC-or-ts; the ts is the dominant term and the only
-- one that can produce a STRICT older/newer clobber). Every federated op carries
-- it (`PeerLogOp.ts`). We persist it as a dedicated `fed_ts` column on every
-- federated table whose projection does a mutating `ON CONFLICT ... DO UPDATE`,
-- then guard the upsert with `WHERE EXCLUDED.fed_ts >= <table>.fed_ts` (the `>=`
-- mirrors lwwPick: a strictly-older op is dropped; an equal-or-newer op applies,
-- and on an exact ts tie lwwPick's del>put / source-key tiebreak is a valid LWW
-- outcome that loses no data whichever way it lands).
--
-- `fed_ts` is nullable + defaults NULL so the column add is instant and existing
-- rows backfill lazily: a NULL stored fed_ts is treated as "older than anything"
-- by the writers' `IS NULL OR ... ` guard, so the first federated write after
-- this migration always lands and stamps fed_ts. Append-only / DO NOTHING
-- projections (contributor_usage_events, feature_claims) need no guard and are
-- intentionally omitted.

ALTER TABLE harness_shared.harness_features_consolidated ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.harness_issues_consolidated   ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.harness_feature_prs           ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.shared_presence               ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.contributors                  ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.feature_queue                 ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.feature_working_set           ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.harness_plans                 ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.coord_conversations           ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.coord_event_log               ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.coord_threads                 ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.coord_thread_posts            ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
ALTER TABLE harness_shared.plan_item_assignments         ADD COLUMN IF NOT EXISTS fed_ts BIGINT;
