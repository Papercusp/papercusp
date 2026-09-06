-- 1128: serve the HUD conversation's stable-owner history without scanning the
-- full faithful-parts corpus (hud-owner-conversation-history-2026-09-05 P-001).
--
-- Carry-respawn creates a new native session_id while preserving the coord
-- owner id. The conversation popup therefore reads the newest bounded parts
-- window by (owner, event time) across those session ids. Before this index,
-- session_turn_parts had no general owner-leading index: the only owner index
-- was partial to part_kind='tool_use' for completion corroboration, so a normal
-- conversation containing text/thinking/results required a full-table scan.
--
-- COALESCE(ts, ingested_at) is the route's event-time ordering expression. The
-- partial predicate drops ownerless shared transcripts that cannot participate
-- in an owner-scoped popup. Additive DDL; older releases ignore it safely.

CREATE INDEX IF NOT EXISTS session_turn_parts_owner_event_at_idx
    ON harness_shared.session_turn_parts (owner, (COALESCE(ts, ingested_at)) DESC)
 WHERE owner IS NOT NULL;

COMMENT ON INDEX harness_shared.session_turn_parts_owner_event_at_idx IS
  'Bounded newest-first faithful conversation history across native-session epochs for one stable coord owner (hud-owner-conversation-history-2026-09-05 P-001).';
