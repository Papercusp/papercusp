-- Per-harness tables. Replace {{SCHEMA}} with harness_<slug_with_underscores>.
-- Idempotent — safe to re-run.

CREATE SCHEMA IF NOT EXISTS {{SCHEMA}};

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.harness_features (
  harness_slug TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL,
  attempts BIGINT NOT NULL DEFAULT 0,
  claims TEXT,
  notes TEXT,
  metadata JSONB,
  kind TEXT,
  project_id TEXT,
  expected_cost_cents BIGINT,
  tags JSONB,
  needs_human_review BOOLEAN NOT NULL DEFAULT FALSE,
  ts BIGINT,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL,
  -- Goal-ancestry: parent feature + top-level goal (cross-schema FK).
  parent_id TEXT,
  goal_id TEXT,
  -- Atomic checkout (FOR UPDATE SKIP LOCKED idiom).
  taken_by TEXT,
  taken_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  -- Deprecation: set when status='deprecated' to record why the feature
  -- was retired (typically: SPEC.md no longer references it). Code is
  -- not auto-removed; this is a metadata-only retirement.
  deprecation_reason TEXT,
  PRIMARY KEY (harness_slug, feature_id)
);
ALTER TABLE {{SCHEMA}}.harness_features ADD COLUMN IF NOT EXISTS deprecation_reason TEXT;
CREATE INDEX IF NOT EXISTS hf_status_idx  ON {{SCHEMA}}.harness_features(harness_slug, status);
CREATE INDEX IF NOT EXISTS hf_project_idx ON {{SCHEMA}}.harness_features(project_id);
CREATE INDEX IF NOT EXISTS hf_review_idx  ON {{SCHEMA}}.harness_features(needs_human_review);
CREATE INDEX IF NOT EXISTS hf_goal_idx    ON {{SCHEMA}}.harness_features(goal_id);
CREATE INDEX IF NOT EXISTS hf_parent_idx  ON {{SCHEMA}}.harness_features(harness_slug, parent_id);
CREATE INDEX IF NOT EXISTS hf_available_idx
  ON {{SCHEMA}}.harness_features(harness_slug, status)
  WHERE taken_by IS NULL;
CREATE INDEX IF NOT EXISTS hf_expires_idx
  ON {{SCHEMA}}.harness_features(expires_at)
  WHERE taken_by IS NOT NULL;

-- Trigger that mirrors writes into harness_shared.harness_features_consolidated
-- so the cross-harness /features page can subscribe via Zero. The trigger
-- function is defined in libs/db/sql/001-shared.sql; this just attaches it.
DROP TRIGGER IF EXISTS sync_consolidated_trg ON {{SCHEMA}}.harness_features;
CREATE TRIGGER sync_consolidated_trg
  AFTER INSERT OR UPDATE OR DELETE ON {{SCHEMA}}.harness_features
  FOR EACH ROW EXECUTE FUNCTION harness_shared.sync_features_consolidated();

CREATE TABLE IF NOT EXISTS {{SCHEMA}}.feature_audit (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
  harness_slug TEXT NOT NULL,
  feature_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor TEXT
);
CREATE INDEX IF NOT EXISTS fa_ts_idx      ON {{SCHEMA}}.feature_audit(ts);
CREATE INDEX IF NOT EXISTS fa_feature_idx ON {{SCHEMA}}.feature_audit(harness_slug, feature_id);

-- Agent-run metadata. The .out blob (full stdout transcript) and .jsonl
-- event stream stay on disk in `.harness/logs/<runId>.{out,jsonl}` (S3+DB
-- pattern). PG holds queryable run metadata + token/cost aggregates so
-- both RecentAgentsTable and UsagePanel can subscribe via Zero instead of
-- polling. `run_id` is the filename stem (`<ts>-<role>[-<featureId>]`).
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.agent_runs (
  harness_slug TEXT NOT NULL,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  feature_id TEXT,
  ts BIGINT NOT NULL,                       -- spawn time (epoch ms, from filename)
  size_bytes BIGINT NOT NULL DEFAULT 0,     -- .out file size
  duration_ms BIGINT NOT NULL DEFAULT 0,    -- from result line
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  running BOOLEAN NOT NULL DEFAULT FALSE,
  last_event_ts BIGINT,                     -- latest .jsonl line ts (epoch ms)
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL,
  PRIMARY KEY (harness_slug, run_id)
);
CREATE INDEX IF NOT EXISTS ar_role_idx     ON {{SCHEMA}}.agent_runs(harness_slug, role);
CREATE INDEX IF NOT EXISTS ar_feature_idx  ON {{SCHEMA}}.agent_runs(harness_slug, feature_id);
CREATE INDEX IF NOT EXISTS ar_ts_idx       ON {{SCHEMA}}.agent_runs(harness_slug, ts DESC);
CREATE INDEX IF NOT EXISTS ar_running_idx  ON {{SCHEMA}}.agent_runs(harness_slug, running) WHERE running = TRUE;

-- Product proposal metadata. The proposal body + reviewer verdict body
-- stay on disk in `.harness/proposals/<id>.md` + `.<id>.review.md` (S3+DB
-- pattern — filesystem holds the markdown blob, PG holds queryable metadata
-- so Zero can subscribe). `proposal_id` IS the filename (e.g.
-- `2026-04-24T22-38-19Z.md`).
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.harness_proposals (
  harness_slug TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,                     -- 'pending' | 'applied' | 'rejected'
  review_verdict TEXT,                      -- 'accept' | 'reject' | 'defer' | NULL
  review_summary TEXT,
  reviewed_at BIGINT,
  applied_at BIGINT,                        -- when applied to SPEC.md (epoch ms); NULL if pending/rejected
  rejected_at BIGINT,                       -- when rejected (epoch ms); NULL if pending/applied
  ts BIGINT NOT NULL,                       -- file mtime (epoch ms)
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL,
  PRIMARY KEY (harness_slug, proposal_id)
);
-- Idempotent column adds for harnesses created before applied_at /
-- rejected_at landed (the CREATE TABLE IF NOT EXISTS above is no-op
-- when the table already exists, so the columns wouldn't otherwise
-- get added on re-template).
ALTER TABLE {{SCHEMA}}.harness_proposals ADD COLUMN IF NOT EXISTS applied_at BIGINT;
ALTER TABLE {{SCHEMA}}.harness_proposals ADD COLUMN IF NOT EXISTS rejected_at BIGINT;
CREATE INDEX IF NOT EXISTS hp_status_idx   ON {{SCHEMA}}.harness_proposals(harness_slug, status);
CREATE INDEX IF NOT EXISTS hp_verdict_idx  ON {{SCHEMA}}.harness_proposals(harness_slug, review_verdict);
CREATE INDEX IF NOT EXISTS hp_ts_idx       ON {{SCHEMA}}.harness_proposals(harness_slug, ts DESC);

-- Curator-owned issue tracker. Mirrors the legacy `.harness/issues.json`
-- shape; `notes` stays inline JSONB (always a small array per row).
-- `issue_id` is "I-NNNN"; nextId is derived MAX+1 at insert time.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.harness_issues (
  harness_slug TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  found_at TIMESTAMPTZ NOT NULL,
  found_during TEXT,
  repro TEXT,
  evidence TEXT,
  suggested_fix TEXT,
  code_pointer TEXT,
  linked_feature_id TEXT,
  attempts BIGINT NOT NULL DEFAULT 0,
  notes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_ts BIGINT NOT NULL,
  updated_ts BIGINT NOT NULL,
  PRIMARY KEY (harness_slug, issue_id)
);
CREATE INDEX IF NOT EXISTS hi_status_idx        ON {{SCHEMA}}.harness_issues(harness_slug, status);
CREATE INDEX IF NOT EXISTS hi_severity_idx      ON {{SCHEMA}}.harness_issues(harness_slug, severity);
CREATE INDEX IF NOT EXISTS hi_found_during_idx  ON {{SCHEMA}}.harness_issues(found_during);
CREATE INDEX IF NOT EXISTS hi_linked_idx        ON {{SCHEMA}}.harness_issues(linked_feature_id);

-- Agent chats (Phase B): persistent conversational sessions with role-scoped
-- agents. Each chat assembles the role's full prompt (same as autonomous
-- dispatches) and stores the user/assistant transcript. Chats are side-channel
-- to the autonomous loop — they read state and may write supervisor-notes /
-- operator-notes, but do not directly mutate the worktree or feature rows.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.agent_chats (
  id            TEXT PRIMARY KEY,
  role          TEXT NOT NULL,                                 -- 'worker' | 'validator' | 'architect' | …
  feature_id    TEXT,                                          -- nullable: harness-level chats have no feature
  title         TEXT,                                          -- user-editable; defaults from role + featureId
  transcript    JSONB NOT NULL DEFAULT '[]'::jsonb,            -- [{role: 'user'|'assistant', content, ts, tokens?}, …]
  total_input_tokens   BIGINT NOT NULL DEFAULT 0,
  total_output_tokens  BIGINT NOT NULL DEFAULT 0,
  total_cost_usd_cents BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ac_role_idx        ON {{SCHEMA}}.agent_chats(role);
CREATE INDEX IF NOT EXISTS ac_feature_idx     ON {{SCHEMA}}.agent_chats(feature_id);
CREATE INDEX IF NOT EXISTS ac_archived_idx    ON {{SCHEMA}}.agent_chats(archived_at);
CREATE INDEX IF NOT EXISTS ac_updated_at_idx  ON {{SCHEMA}}.agent_chats(updated_at DESC);

-- Snapshot metadata. Each row is a `.harness/snapshots/<id>/` dir; the
-- directory itself stays on disk (config.json + features.json + notes
-- files), only the metadata is mirrored into PG so SnapshotsPanel can
-- subscribe via Zero instead of polling the FS scan.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.harness_snapshots (
  harness_slug TEXT NOT NULL,
  snapshot_id  TEXT NOT NULL,
  ts           BIGINT NOT NULL,
  iter_num     INT NOT NULL DEFAULT 0,
  files        JSONB NOT NULL DEFAULT '[]'::jsonb,
  feature_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_ts   BIGINT NOT NULL,
  updated_ts   BIGINT NOT NULL,
  PRIMARY KEY (harness_slug, snapshot_id)
);
CREATE INDEX IF NOT EXISTS hs_ts_idx       ON {{SCHEMA}}.harness_snapshots(harness_slug, ts DESC);
CREATE INDEX IF NOT EXISTS hs_iter_idx     ON {{SCHEMA}}.harness_snapshots(harness_slug, iter_num DESC);

-- ── Multi-harness spawning support (008) ─────────────────────────────────

-- Per-harness shared-secret token used to authenticate this harness's
-- requests to /api/admin/execute-action. Generated once at scaffold time;
-- stored alongside the .harness/config.json:harness_token file. Mirrored
-- to harness_shared.token_index for O(1) bearer→slug resolution.
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.config_token (
  token TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cross-harness message inbox. `from_slug` is server-derived from the
-- bearer token at insert time; never trust the body's `from`.
-- Optional `to_role` narrows the recipient to a specific role within the
-- target harness; receiver's prompt-build filters on (to_role IS NULL OR to_role = me).
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_slug TEXT NOT NULL,
  to_slug TEXT NOT NULL,
  to_role TEXT,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT,
  parent_message_id UUID,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  CHECK (status IN ('pending', 'acknowledged', 'archived'))
);
CREATE INDEX IF NOT EXISTS messages_status_idx ON {{SCHEMA}}.messages(status, created_at);
CREATE INDEX IF NOT EXISTS messages_to_idx     ON {{SCHEMA}}.messages(to_slug, status);
CREATE INDEX IF NOT EXISTS messages_from_idx   ON {{SCHEMA}}.messages(from_slug, created_at);
CREATE INDEX IF NOT EXISTS messages_to_role_idx ON {{SCHEMA}}.messages(to_slug, to_role) WHERE to_role IS NOT NULL;

-- Supervisor-side rolling notes. Auto-appended on inbound Directive kind
-- messages (so the receiving harness's prompt-build can surface fresh
-- guidance without re-reading the whole inbox).
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.supervisor_notes (
  id BIGSERIAL PRIMARY KEY,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Directive summaries — long-running directive memory. Append-only.
-- Used by the director's prompt-build to surface compressed context for
-- directives that span many iterations. Indexed by (directive_id, ts).
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.directive_summaries (
  id BIGSERIAL PRIMARY KEY,
  directive_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ceo',
  summary TEXT NOT NULL,
  caller_slug TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS directive_summaries_directive_idx ON {{SCHEMA}}.directive_summaries(directive_id, created_at DESC);

-- executeAction idempotency cache. caller_slug is the bearer-derived
-- identity; target_slug carries the receiving harness for cross-harness
-- ops (NULL for self-ops like mark_message_status).
CREATE TABLE IF NOT EXISTS {{SCHEMA}}.executed_actions (
  action_id UUID PRIMARY KEY,
  op TEXT NOT NULL,
  caller_slug TEXT NOT NULL,
  target_slug TEXT,
  reason TEXT,
  request JSONB NOT NULL,
  response JSONB NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS executed_actions_caller_idx ON {{SCHEMA}}.executed_actions(caller_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_target_idx ON {{SCHEMA}}.executed_actions(target_slug, executed_at DESC);
CREATE INDEX IF NOT EXISTS executed_actions_op_idx     ON {{SCHEMA}}.executed_actions(op, executed_at DESC);

-- ──────────────────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA {{SCHEMA}} TO harness_app, harness_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {{SCHEMA}} TO harness_app, harness_admin;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA {{SCHEMA}} TO harness_app, harness_admin;
