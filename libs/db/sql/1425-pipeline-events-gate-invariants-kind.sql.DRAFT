-- 1425-pipeline-events-gate-invariants-kind.sql
-- WI-10007479 (plan green-main-cycle-time-2026-10-08 P-018): admit the standing gate
-- invariant ledger kind 'gate_invariants' into harness_shared.pipeline_events.
--
-- P-018 checks six live invariants of the gate mechanisms earlier plans shipped (fixer spawn
-- latency, targeted repair radius, admission pre-check, no-verdict rate, round idle time,
-- executor freshness) on every green-stall-watchdog tick. The plan's acceptance needs 7 days of
-- live passes, so each evaluation's outcome must be durable history, not only the mutable
-- routines.metadata->'gate_invariants' slot each tick overwrites.
--
-- WHY A SEPARATE KIND, for the reason 1054 and 1167 recorded: live consumers treat "a
-- green_checkpoint row exists" as "an outcome happened" (green-stall-watchdog's
-- last_verdict_ms subquery, readLastGateRunEvidence, lost-wake-detect, the /admin pipeline
-- window), and reconstructGateFireDays counts green_checkpoint_fire rows as fires. An invariant
-- row under either kind would corrupt those readings. Every existing consumer filters kind
-- exactly, so a distinct kind is invisible to all of them.
--
-- FORWARD-COMPAT: the DROP is immediately followed by re-adding the same constraint over a strict
-- SUPERSET of the kinds (every previously allowed kind plus 'gate_invariants'), inside the same
-- migration transaction. The deployed release only writes kinds that remain allowed, so no
-- release still live can observe a missing or narrower check.
ALTER TABLE harness_shared.pipeline_events
  DROP CONSTRAINT pipeline_events_kind_check;
ALTER TABLE harness_shared.pipeline_events
  ADD CONSTRAINT pipeline_events_kind_check
  CHECK (kind = ANY (ARRAY[
    'git_sync'::text,
    'merge_resolver'::text,
    'content_fixer'::text,
    'green_checkpoint'::text,
    'green_checkpoint_fire'::text,
    'gate_fire_drill'::text,
    'deploy'::text,
    'release_fixer'::text,
    'green_checkpoint_repair_latency'::text,
    'gate_invariants'::text
  ]));
