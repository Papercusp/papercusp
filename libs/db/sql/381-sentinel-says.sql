-- 381-sentinel-says.sql — voice-OUT buffer for the Sentinel-as-Claude-TUI
-- (sentinel-as-claude-tui-2026-06-22, Phase D).
--
-- The Sentinel (a psu/Claude-Code dock session) calls the `voice:say` MCP tool,
-- which INSERTs a spoken line here; the webview voice runtime polls
-- GET /api/operator/sentinel-output, which drains (SELECT+DELETE) and runs each
-- line through the local TTS. PG bridges the two — the sentinel's MCP operator
-- and the webview's operator are SEPARATE processes, so an in-memory buffer
-- could not connect them (and the PG storage policy mandates this anyway).
--
-- Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS harness_shared.sentinel_says (
  id          bigserial   PRIMARY KEY,
  text        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
