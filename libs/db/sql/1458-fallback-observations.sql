-- 1458-fallback-observations.sql
--
-- degradation-signals-on-condition-rail-2026-10-11 P-002 (BAR R-1, D-001),
-- WI-6554700010008597.
--
-- Durable record of fail-open / fallback decisions. A mechanism that can
-- quietly fall back (the gate's pass-reuse selector, a retrieval leg, a
-- transport, a self-healing watchdog) records one row per decision batch:
-- how many units were ELIGIBLE for the primary path, how many it actually
-- APPLIED, and the REASON it took (e.g. 'proofs-unavailable', 'applied').
--
-- Why a table and not the per-process leg-health ring (D-001): the gate's
-- reuse decisions run in child processes (affected-tests / gate-cli), so an
-- in-memory ring in one process is invisible to the watchdog in another.
-- Gate run 762a13a6 reused 0 of ~7,689 eligible tasks and no alarm fired,
-- because the only signal was a log line in a child process.
--
-- Writer: packages/operator-core/lib/degradation/fallback-observations.ts
--   observeFallback() buffers and flushes in batches, best-effort — a write
--   failure never fails the caller's hot path.
-- Reader: readFallbackWindow() aggregates a trailing window per mechanism;
--   the generic degradation watchdog (P-003) opens degraded:<mechanism>:<reason>
--   conditions from it.
-- Retention: pruneFallbackObservations() deletes rows older than the
--   retention window in bounded batches; the watchdog sweep calls it.

CREATE TABLE IF NOT EXISTS harness_shared.fallback_observations (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id  text        NOT NULL DEFAULT 'default',
    mechanism     text        NOT NULL,
    eligible      integer     NOT NULL,
    applied       integer     NOT NULL,
    reason        text        NOT NULL,
    scope         text,
    process_tag   text,
    observed_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fallback_observations_counts_valid
      CHECK (eligible >= 0 AND applied >= 0 AND applied <= eligible),
    CONSTRAINT fallback_observations_mechanism_nonempty
      CHECK (length(btrim(mechanism)) > 0),
    CONSTRAINT fallback_observations_reason_nonempty
      CHECK (length(btrim(reason)) > 0)
);

COMMENT ON TABLE harness_shared.fallback_observations IS
  'One row per fallback decision batch (eligible vs applied + reason). Written best-effort by observeFallback; read by readFallbackWindow and the generic degradation watchdog. degradation-signals-on-condition-rail-2026-10-11 P-002.';
COMMENT ON COLUMN harness_shared.fallback_observations.eligible IS
  'Units that could have taken the primary (non-fallback) path in this batch.';
COMMENT ON COLUMN harness_shared.fallback_observations.applied IS
  'Units that actually took the primary path. applied < eligible means the remainder fell back.';
COMMENT ON COLUMN harness_shared.fallback_observations.reason IS
  'Why the mechanism took the path it did for this batch (e.g. applied, proofs-unavailable, dirty-checkout).';

CREATE INDEX IF NOT EXISTS fallback_observations_mechanism_time_idx
  ON harness_shared.fallback_observations (workspace_id, mechanism, observed_at DESC);

CREATE INDEX IF NOT EXISTS fallback_observations_observed_at_idx
  ON harness_shared.fallback_observations (observed_at);
