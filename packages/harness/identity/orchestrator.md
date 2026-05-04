# IDENTITY — orchestrator

This file is your durable, cross-mission memory. Curator maintains it (append-only). You read it at startup to carry forward lessons from prior missions that the current mission's `.harness/memory/summary.md` doesn't capture.

## Patterns I've learned

- [2026-04-26] Read `.harness/config.json#phase` and `#itemStates` before doing anything else. If your decision rules reference lifecycle keywords (`todo/validating/passed/failing/blocked`) that do not appear in `itemStates` or in any feature's `status` in `features.json`, you are in the wrong phase — escalate on the first run rather than looping. A coding-harness orchestrator dispatched into a `phase: org` harness has zero valid transitions; every loop re-emits the same escalation and burns hours (run 1777193472 looped ~4h / 6 reviewer cycles before the mismatch was captured).

## Failures I've seen

- [2026-04-26] Coding-harness `orchestrator` role looped uselessly inside a `phase:org` harness — no feature ever carried `todo/validating/passed/failing`, so `NEXT_WORKER`, `NEXT_VALIDATOR`, `convert_issues`, `next_architect`, `done` were all inapplicable. Each loop re-emitted the same escalation. Run `1777193472-orchestrator`. The signal you have this fault: every transition predicate evaluates false on the first feature you inspect.

## Context shortcuts

- [2026-04-26] Phase → role/lifecycle map: `phase:org` uses roles `coordinator / director / auditor` with lifecycle `proposed → approved → in_progress → launched / paused / cancelled`. Coding-phase uses lifecycle `todo / validating / passed / failing / blocked`. Source of truth: `.harness/config.json#phase`, `#itemStates`, `#roles`. Check these before assuming any transition keyword exists.
- [2026-04-28] If the harness-features CLI is absent AND localhost:3001 returns 404 AND features.json is a stub/test file, the feature queue is completely inaccessible. Escalate immediately on the first iteration with reason "feature queue inaccessible" — do NOT retry or loop. This is an infrastructure fault requiring supervisor intervention, not a recoverable condition.
- [2026-04-30] When features.json is lost/stubbed but Postgres/CLI are also inaccessible, supervisor can restore from git: `git restore .harness/features.json`. This recovers the last committed feature state (status, attempts). Suggest this to supervisor explicitly in the escalation rather than just asking to 'restore Postgres'. Evidence: sheets-clone 2026-04-30 recovery.
