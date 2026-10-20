-- 1535: stored daily bug-inflow rollup
-- (bug-inflow-one-problem-one-row-2026-10-18 P-007 / R-6, WI-6554700010017181).
--
-- Owner directive #1990 approved a brief that shows bugs FILED per day by
-- source next to bugs CLOSED per day. R-6 requires that reading to come from
-- STORED values, never a live aggregate on the read path: the work.bugInflow
-- state cell (and the fleet leader brief) SELECT these rows and nothing else.
--
-- Writer: the improvement-watchdog tick (lib/harness/improvements/bug-inflow.ts
-- refreshBugInflowDaily) recomputes the current and previous UTC day for one
-- workspace and upserts them, so a row is at most one tick stale and a day that
-- has ended is final once the next day's first tick has run.
--
-- Population: issue-family work items (item_kind bug | change | task), lane
-- distinct from 'observation' (an observation is a reflection, not a filed
-- problem). filed_by_source buckets each filing by its reporter (payload.source,
-- else watchdog, else role:<filedByRole>, else reporterKinds[0], else
-- unattributed). closed_by_status buckets each close by its terminal status, so
-- the brief can tell a fix from a duplicate drop.
--
-- Additive only: a new table, no change to any existing relation.

CREATE TABLE IF NOT EXISTS harness_shared.bug_inflow_daily (
  workspace_id     text        NOT NULL,
  day              date        NOT NULL,
  filed_total      integer     NOT NULL DEFAULT 0,
  filed_by_source  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  closed_total     integer     NOT NULL DEFAULT 0,
  closed_by_status jsonb       NOT NULL DEFAULT '{}'::jsonb,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, day)
);

COMMENT ON TABLE harness_shared.bug_inflow_daily IS
  'Stored per-UTC-day issue-family inflow (filed by source) vs closes (by terminal status). Written by the improvement-watchdog tick; read by the work.bugInflow cell and the fleet leader brief. bug-inflow-one-problem-one-row-2026-10-18 R-6.';
COMMENT ON COLUMN harness_shared.bug_inflow_daily.filed_by_source IS
  'Object source -> count of issue-family, non-observation rows created that UTC day.';
COMMENT ON COLUMN harness_shared.bug_inflow_daily.closed_by_status IS
  'Object terminal status -> count of issue-family, non-observation rows whose closed_ts falls in that UTC day.';
COMMENT ON COLUMN harness_shared.bug_inflow_daily.computed_at IS
  'When the writer last recomputed this day; the reader reports staleness from it.';
