-- 1544-code-intel-push-skips.sql
--
-- WI-6554700010018440. The code-intelligence leg of the mid-turn push shares a
-- 1,500-char per-turn budget with memory recall (push-channel.ts
-- CODE_INTEL_PUSH_TURN_CHARS). A fact that does not fit is dropped whole (never
-- clipped), and until now that drop left no trace, so there was no way to tell
-- whether the shared budget is starving code intelligence. This table records
-- each budget drop, so it can be measured per leg/day before anyone decides on a
-- separate code-intel budget.
--
-- Both drop sites (the request pre-filter in codeIntelPushText and the commit loop)
-- are recorded by commitPushFacts, inside the code_intel_pushes transaction, which
-- classifies each drop by the limit that bound it:
--   * site = 'request-budget': the request's share (1,500 minus the memory block
--     delivered in the same hook response, minus facts this request delivered)
--     was STRICTLY smaller than what the turn had left. Memory recall cost it.
--   * site = 'turn-budget': the turn's own code-intel spend was the limit,
--     including a tie (memory took nothing; code intelligence filled the turn).
--
-- Why not code_intel_pushes itself: its UNIQUE (workspace_id, owner_id, epoch,
-- leg, subject) + ON CONFLICT DO NOTHING is the cross-worker delivery dedupe. A
-- skip row there would suppress the REAL delivery of that fact for the rest of
-- the compaction epoch.
--
-- A fact already delivered this epoch is not recorded (the writer's NOT EXISTS
-- against code_intel_pushes): re-offering a delivered fact is not a budget loss.
-- One row per fact per turn (the unique key). A fact skipped in one batch and
-- delivered in a later batch of the same turn shows up as a skip row plus a
-- code_intel_pushes row with a later pushed_at; that join is the "delayed, not
-- lost" measurement.
--
-- Not covered: a request whose memory block took the WHOLE 1,500 chars never
-- runs the legs, so it has no candidate facts to record.

CREATE TABLE IF NOT EXISTS harness_shared.code_intel_push_skips (
  id            bigserial   PRIMARY KEY,
  workspace_id  text        NOT NULL,
  owner_id      text        NOT NULL,
  epoch         integer     NOT NULL DEFAULT 0,
  turn_id       text        NOT NULL,
  leg           text        NOT NULL,
  subject       text        NOT NULL,
  chars         integer     NOT NULL,
  budget_left   integer     NOT NULL,
  site          text        NOT NULL,
  client        text,
  skipped_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_intel_push_skips_chars_nonneg CHECK (chars >= 0),
  CONSTRAINT code_intel_push_skips_site_known CHECK (site IN ('request-budget', 'turn-budget')),
  CONSTRAINT code_intel_push_skips_turn_fact_key
    UNIQUE (workspace_id, owner_id, turn_id, leg, subject)
);

-- The measurement read: drops per leg over a time window (pairs with
-- code_intel_pushes_leg_time_idx on the delivery side).
CREATE INDEX IF NOT EXISTS code_intel_push_skips_leg_time_idx
  ON harness_shared.code_intel_push_skips (workspace_id, leg, skipped_at);

COMMENT ON TABLE harness_shared.code_intel_push_skips IS
  'WI-6554700010018440: one row per code-intelligence fact dropped for budget by the mid-turn push (never clipped, so dropped whole). Kept apart from code_intel_pushes, whose unique key is the delivery dedupe. Unique (workspace, owner, turn, leg, subject) = one row per fact per turn.';
COMMENT ON COLUMN harness_shared.code_intel_push_skips.chars IS
  'Rendered size of the dropped fact (formatPushFact length + 2 separator chars), same unit as code_intel_pushes.chars.';
COMMENT ON COLUMN harness_shared.code_intel_push_skips.budget_left IS
  'Chars the binding budget had left when the fact was dropped (request share or turn remainder, per site).';
COMMENT ON COLUMN harness_shared.code_intel_push_skips.site IS
  'request-budget = the request share left after memory recall and earlier facts was strictly the binding limit; turn-budget = the turn''s own code-intel spend was (ties included).';

ALTER TABLE harness_shared.code_intel_push_skips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS code_intel_push_skips_workspace ON harness_shared.code_intel_push_skips;
CREATE POLICY code_intel_push_skips_workspace ON harness_shared.code_intel_push_skips
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.code_intel_push_skips TO harness_app;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.code_intel_push_skips_id_seq TO harness_app;
