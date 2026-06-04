-- 151-operator-curation.sql
-- Curator-operator (plan curator-operator-2026-06-04): the salience curation loop.
--
-- Two tables, both workspace-scoped, in harness_shared:
--   operator_curation_log   — dedup memory backing the salience idempotency
--                             overlay ("already surfaced" → don't re-nag).
--   operator_curation_state — per-workspace cadence/backoff state ("faster when
--                             busy, slower when quiet"), the autoloop_state analog.
-- Idempotent (CREATE ... IF NOT EXISTS) per the storage policy.

CREATE TABLE IF NOT EXISTS harness_shared.operator_curation_log (
    workspace_id   text        NOT NULL,
    signal_id      text        NOT NULL,
    kind           text        NOT NULL,
    policy_version text        NOT NULL DEFAULT '',
    surfaced_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operator_curation_log_pkey PRIMARY KEY (workspace_id, signal_id)
);

-- Window lookups ("ids surfaced in the last 24h") + the audit view (newest first).
CREATE INDEX IF NOT EXISTS operator_curation_log_surfaced_idx
    ON harness_shared.operator_curation_log (workspace_id, surfaced_at DESC);

COMMENT ON TABLE harness_shared.operator_curation_log IS
    'Curator-operator dedup memory: FleetSignal ids the operator has already surfaced/batched, per workspace. Backs the salience idempotency overlay so the same fact is not re-surfaced every tick. De-dup, not suppression — the raw item stays reachable via the coord inbox + drill-in ref (D-005).';

CREATE TABLE IF NOT EXISTS harness_shared.operator_curation_state (
    workspace_id             text        NOT NULL,
    last_run_at              timestamptz,
    last_digest_at           timestamptz,
    current_interval_seconds integer     NOT NULL DEFAULT 120,
    consecutive_quiet        integer     NOT NULL DEFAULT 0,
    last_surfaced_count      integer     NOT NULL DEFAULT 0,
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT operator_curation_state_pkey PRIMARY KEY (workspace_id)
);

COMMENT ON TABLE harness_shared.operator_curation_state IS
    'Curator-operator per-workspace cadence/backoff state: when the loop last ran/digested and the adaptive interval (grows when quiet, resets when busy). The autoloop_state analog for the curation loop.';
