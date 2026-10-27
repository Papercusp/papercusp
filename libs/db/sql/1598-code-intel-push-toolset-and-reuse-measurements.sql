-- 1598-code-intel-push-toolset-and-reuse-measurements.sql
--
-- code-intel-delivery-and-outcomes-2026-10-26 P-006 (WI-6554700010029480).
--
-- 1. harness_shared.session_exposed_tools — the tool list a session was last
--    shown by tools/list (after the seed, identity, role, confinement and
--    compact filters), one row per (workspace, owner). Code-intel pushes and
--    task briefs name a follow-up tool only when it is in this list
--    (SPEC-P-006-B). The list lived only in one operator process's memory
--    (tool-allowlist.ts sessionSurfaces), but a hook push and an MCP listing
--    can land on different processes (:3070, :3170, bg-host), so the push side
--    could not read it. No row = unknown toolset = no tool is named.
--    Names are stored normalized (normalizeMcpName: lower-case, colon form).
--
-- 2. harness_shared.code_intel_reuse_measurements — the reuse-measurement,
--    reuse-metrics and reuse-provider-action records. They were written into
--    code_intel_pushes with chars = 0 and their JSON payload in suggested_call,
--    so the delivered-push log counted measurements as pushes and showed a JSON
--    blob as a "suggested call" (EI-27013395716645252, SPEC-P-006-C).
--    Existing rows are copied here. The originals stay in code_intel_pushes
--    until a later contract migration deletes them: the deployed :3070 release
--    still reads them there until it is redeployed (expand now, contract later).

CREATE TABLE IF NOT EXISTS harness_shared.session_exposed_tools (
  workspace_id  text        NOT NULL,
  owner_id      text        NOT NULL,
  tools         text[]      NOT NULL,
  listed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, owner_id)
);

COMMENT ON TABLE harness_shared.session_exposed_tools IS
  'P-006 (code-intel-delivery-and-outcomes-2026-10-26): the normalized tool names the owner''s session was last listed by tools/list, after every listing filter. Pushes name a follow-up tool only when it is here; no row means the toolset is unknown and no tool is named.';

CREATE TABLE IF NOT EXISTS harness_shared.code_intel_reuse_measurements (
  id            bigserial   PRIMARY KEY,
  workspace_id  text        NOT NULL,
  owner_id      text        NOT NULL,
  epoch         integer     NOT NULL DEFAULT 0,
  turn_id       text        NOT NULL,
  kind          text        NOT NULL,
  subject       text        NOT NULL,
  payload       text,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_intel_reuse_measurements_kind_known
    CHECK (kind IN ('reuse-measurement', 'reuse-metrics', 'reuse-provider-action')),
  CONSTRAINT code_intel_reuse_measurements_key
    UNIQUE (workspace_id, owner_id, epoch, kind, subject)
);

CREATE INDEX IF NOT EXISTS code_intel_reuse_measurements_kind_time_idx
  ON harness_shared.code_intel_reuse_measurements (workspace_id, kind, recorded_at);

COMMENT ON TABLE harness_shared.code_intel_reuse_measurements IS
  'P-006 (code-intel-delivery-and-outcomes-2026-10-26): reuse-brief measurement records (exposure windows, metric populations, provider actions). They are measurements, not deliveries, so they live outside code_intel_pushes. payload holds the hash-verified JSON record the subject references.';

INSERT INTO harness_shared.code_intel_reuse_measurements
  (workspace_id, owner_id, epoch, turn_id, kind, subject, payload, recorded_at)
SELECT workspace_id, owner_id, epoch, turn_id, leg, subject, suggested_call, pushed_at
  FROM harness_shared.code_intel_pushes
 WHERE leg IN ('reuse-measurement', 'reuse-metrics', 'reuse-provider-action')
   AND chars = 0
ON CONFLICT (workspace_id, owner_id, epoch, kind, subject) DO NOTHING;
