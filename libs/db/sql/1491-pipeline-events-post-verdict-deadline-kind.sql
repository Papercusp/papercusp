-- 1491-pipeline-events-post-verdict-deadline-kind.sql
-- WI-6554700010010213: admit the kind 'green_checkpoint_post_verdict' into
-- harness_shared.pipeline_events.
--
-- WI-6554700010009547 bounded each observational post-verdict step of a green-checkpoint run
-- (the derived freeze-disposition write, frozen-repair leg routing) with a deadline, because run
-- b874ad21 hung ~2h after its verdict existed. That bound turns a hang into a skip. Until now
-- the skip was recorded only as a line in the checkpoint log, so a step that times out on every
-- run (leg work-items never minted or settled) was invisible to /admin/git and routines health.
-- Each deadline overrun is now appended as one pipeline event of this kind.
--
-- WHY A SEPARATE KIND, for the reason 1054, 1167 and 1425 recorded: live consumers treat "a
-- green_checkpoint row exists" as "an outcome happened" (green-stall-watchdog's
-- last_verdict_ms subquery, readLastGateRunEvidence, lost-wake-detect, the /admin pipeline
-- window), and reconstructGateFireDays counts green_checkpoint_fire rows as fires. A deadline
-- row under either kind would corrupt those readings. Every existing consumer filters kind
-- exactly, so a distinct kind is invisible to all of them.
--
-- FORWARD-COMPAT: the DROP is immediately followed by re-adding the same constraint over a strict
-- SUPERSET of the kinds (every previously allowed kind plus 'green_checkpoint_post_verdict'),
-- inside the same migration transaction. The deployed release only writes kinds that remain
-- allowed, so no release still live can observe a missing or narrower check.
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
    'gate_invariants'::text,
    'green_checkpoint_post_verdict'::text
  ]));
