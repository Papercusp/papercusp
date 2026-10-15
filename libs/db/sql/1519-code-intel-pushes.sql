-- 1519-code-intel-pushes.sql
--
-- native-code-intelligence-ecosystem-and-dream-2026-10-09 P-034 / D-016.
-- The ledger behind the code-intelligence leg of the mid-turn context push
-- (PostToolBatch -> /api/agent-mcp/mid-turn-context). One row per fact that
-- was actually PUT INTO A HOOK RESPONSE. It serves three purposes:
--
--   1. PER-SESSION DEDUPE. The unique key (workspace_id, owner_id, epoch, leg,
--      subject) makes "push this fact" an INSERT ... ON CONFLICT DO NOTHING
--      RETURNING: across every SO_REUSEPORT worker exactly one request wins,
--      and only the winner renders the fact. `epoch` is the session's
--      COMPACTION generation (memory_session_epochs), so a compaction makes
--      every fact pushable again: the context that carried it is gone.
--   2. PER-TURN BUDGET. `turn_id` is the durable hook turn
--      (identity_hook_turns.turn_id), opened by turn-start for every prompt.
--      SUM(chars) over the current turn is the spend checked against the
--      leg's per-turn character budget.
--   3. P-041 TELEMETRY. leg + subject + cited_paths + suggested_call +
--      pushed_at are what the push-outcome instrument joins against
--      tool_invocations to measure acted-on and grep-after-push rates.
--
-- Why not an existing table:
--   * corpus_session_surfaced (712) has the right dedupe key shape, but it is
--     GC'd at 14 days and carries no payload (no cited paths, no snapshot
--     identity, no size), so P-041 could not measure acted-on from it.
--   * context_injection_coverage (772) is a DAILY COUNTER keyed by tool, with
--     no subject and no per-push row.
--
-- Rows are only written for delivered facts, so volume is bounded by the
-- per-turn budget (~1.5k chars a turn, a handful of rows).

CREATE TABLE IF NOT EXISTS harness_shared.code_intel_pushes (
  id                     bigserial   PRIMARY KEY,
  workspace_id           text        NOT NULL,
  owner_id               text        NOT NULL,
  epoch                  integer     NOT NULL DEFAULT 0,
  turn_id                text        NOT NULL,
  leg                    text        NOT NULL,
  subject                text        NOT NULL,
  snapshot_commit        text,
  snapshot_generated_at  timestamptz,
  cited_paths            text[]      NOT NULL DEFAULT '{}',
  suggested_call         text,
  chars                  integer     NOT NULL,
  client                 text,
  pushed_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_intel_pushes_chars_nonneg CHECK (chars >= 0),
  CONSTRAINT code_intel_pushes_session_fact_key
    UNIQUE (workspace_id, owner_id, epoch, leg, subject)
);

-- The per-turn spend read: SUM(chars) WHERE workspace/owner/turn.
CREATE INDEX IF NOT EXISTS code_intel_pushes_turn_idx
  ON harness_shared.code_intel_pushes (workspace_id, owner_id, turn_id);

-- The P-041 measurement window read: per leg over a time range.
CREATE INDEX IF NOT EXISTS code_intel_pushes_leg_time_idx
  ON harness_shared.code_intel_pushes (workspace_id, leg, pushed_at);

COMMENT ON TABLE harness_shared.code_intel_pushes IS
  'P-034/D-016: one row per code-intelligence fact delivered by the mid-turn push. Unique (workspace, owner, compaction epoch, leg, subject) = cross-worker dedupe; turn_id = durable hook turn for the per-turn budget; leg/subject/cited_paths/suggested_call feed the P-041 push-outcome instrument.';
COMMENT ON COLUMN harness_shared.code_intel_pushes.snapshot_commit IS
  'index.lastCommit of the first-party dependency snapshot the fact was served from (the freshness stamp shown to the agent).';
COMMENT ON COLUMN harness_shared.code_intel_pushes.suggested_call IS
  'A concrete next call the push suggested (for example a testing:run invocation); P-041 counts it as acted-on when the agent runs it.';

ALTER TABLE harness_shared.code_intel_pushes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS code_intel_pushes_workspace ON harness_shared.code_intel_pushes;
CREATE POLICY code_intel_pushes_workspace ON harness_shared.code_intel_pushes
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.code_intel_pushes TO harness_app;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.code_intel_pushes_id_seq TO harness_app;
