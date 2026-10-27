-- 1597-code-intel-push-skips-push-cap-site.sql
--
-- WI-6554700010029479 (code-intel-delivery-and-outcomes-2026-10-26 P-005, R-5).
-- Measured 2026-10-27 over 7 days: 10,143 of 10,793 budget skips were site
-- 'turn-budget', because a single resume or first-touch push rendered at
-- ~1,100-1,200 characters and used up most of the 1,500-character turn budget.
--
-- push-channel.ts now caps each rendered push at CODE_INTEL_PUSH_MAX_CHARS (500
-- characters including its pointer). formatPushFact keeps whole lines only, so a
-- push that still exceeds the cap (an over-long head line) is dropped whole and
-- recorded here:
--   * site = 'push-cap': chars = the rendered size of the dropped push,
--     budget_left = what the turn budget still had.
--
-- The chars unit changes with this release: a fact's chars is now the rendered
-- block length alone (no +2 for the '\n\n' join separator), so three 500-character
-- pushes total exactly 1,500 and fit the reserved turn budget (R-5 D-008/D-009 pin).
--
-- FORWARD-COMPAT: the constraint is widened, not narrowed. The release :3070 serves
-- writes only 'request-budget', 'turn-budget' and (once 1596 applies) 'wall', all of
-- which stay allowed, so dropping and re-adding the CHECK in one ALTER cannot refuse
-- a write from the live build.

ALTER TABLE harness_shared.code_intel_push_skips
  DROP CONSTRAINT IF EXISTS code_intel_push_skips_site_known,
  ADD CONSTRAINT code_intel_push_skips_site_known
    CHECK (site IN ('request-budget', 'turn-budget', 'wall', 'push-cap'));

COMMENT ON COLUMN harness_shared.code_intel_push_skips.chars IS
  'Rendered size of the dropped fact (formatPushFact length; before WI-6554700010029479 it also counted 2 separator chars), same unit as code_intel_pushes.chars. 0 for site wall: the leg never ran, so no fact was rendered.';
COMMENT ON COLUMN harness_shared.code_intel_push_skips.site IS
  'request-budget = the request share was strictly the binding limit (historical: memory recall no longer shares the code-intel budget since WI-6554700010029479); turn-budget = the turn''s own code-intel spend was (ties included); wall = the push wall stopped this enabled leg before it ran while it had work: a context read in flight or a snapshot candidate for the batch (subject leg-not-run:<leg>); push-cap = the rendered push exceeded the 500-character per-push cap and was dropped whole.';
COMMENT ON COLUMN harness_shared.code_intel_pushes.chars IS
  'Rendered size of the delivered push (formatPushFact length). Before WI-6554700010029479 it also counted 2 separator chars.';
