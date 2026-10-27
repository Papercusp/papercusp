-- 1596-code-intel-push-skips-wall-site.sql
--
-- WI-6554700010030085. The mid-turn code-intelligence push runs inside a 250 ms
-- wall (push-channel.ts CODE_INTEL_PUSH_WALL_MS). Until now the legs AND the
-- commit shared that wall, so a slow gather made the wall fire before the commit
-- and every fact already gathered was discarded with no row in code_intel_pushes
-- or code_intel_push_skips (measured on :3170 2026-10-27: 3/3 incident replays).
--
-- codeIntelPushText now stops gathering early enough to leave the commit its own
-- reserve, and records each enabled leg the wall stopped before it ran as one
-- skip row:
--   * site = 'wall': subject 'leg-not-run:<leg>', chars 0, budget_left = what the
--     binding budget still had. One row per leg per turn (the existing unique key),
--     so a liveness reader can tell "this leg produced nothing" from "the wall
--     never let this leg run".
--
-- FORWARD-COMPAT: the constraint is widened, not narrowed. The release :3070 serves
-- writes only 'request-budget' and 'turn-budget', and both stay allowed, so dropping
-- and re-adding the CHECK in one ALTER cannot refuse a write from the live build.

ALTER TABLE harness_shared.code_intel_push_skips
  DROP CONSTRAINT IF EXISTS code_intel_push_skips_site_known,
  ADD CONSTRAINT code_intel_push_skips_site_known
    CHECK (site IN ('request-budget', 'turn-budget', 'wall'));

COMMENT ON TABLE harness_shared.code_intel_push_skips IS
  'WI-6554700010018440: one row per code-intelligence fact dropped for budget by the mid-turn push (never clipped, so dropped whole). WI-6554700010030085: also one row per enabled leg the push wall stopped before it ran (site wall). Kept apart from code_intel_pushes, whose unique key is the delivery dedupe. Unique (workspace, owner, turn, leg, subject) = one row per fact per turn.';
COMMENT ON COLUMN harness_shared.code_intel_push_skips.chars IS
  'Rendered size of the dropped fact (formatPushFact length + 2 separator chars), same unit as code_intel_pushes.chars. 0 for site wall: the leg never ran, so no fact was rendered.';
COMMENT ON COLUMN harness_shared.code_intel_push_skips.site IS
  'request-budget = the request share left after memory recall and earlier facts was strictly the binding limit; turn-budget = the turn''s own code-intel spend was (ties included); wall = the push wall stopped this enabled leg before it ran (subject leg-not-run:<leg>).';
