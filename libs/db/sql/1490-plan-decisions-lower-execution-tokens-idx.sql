-- WI-6554700010009932 (perf audit papercusp-performance-audit-2026-10-12 P-012): index the
-- LOWERCASED body tokens of plan_decisions so reservedPlanLaneExclusionSql can prefilter its
-- Route A execution-route regex exactly.
--
-- The Route A leg matches LOWER(body) ~ 'route a: this session (su-...) implements the plan'.
-- Migration 1364's plan_decisions_execution_tokens_idx indexes case-SENSITIVE tokens, so it
-- cannot be an exact prefilter for a case-insensitive match. Measured 2026-10-13 on live
-- papercusp (14,805 decisions, 26 MB of body): the leg was a 516-587 ms sequential scan that
-- returned 3 rows, paid on every admissible work-item read (work_items:list, coord:orient,
-- scheduler:get_next).
--
-- Splitting LOWER(body) on [^a-z0-9_-]+ yields every whitespace/punctuation-delimited word of
-- a matching body, so `tokens @> ARRAY['route','a','this','session','implements','the','plan']`
-- is a strict superset of the regex and the regex still decides. Additive only: no existing
-- object changes, so the currently-deployed release is unaffected.
CREATE INDEX IF NOT EXISTS plan_decisions_lower_execution_tokens_idx
  ON harness_shared.plan_decisions
  USING gin (regexp_split_to_array(lower(body), '[^a-z0-9_-]+'));
