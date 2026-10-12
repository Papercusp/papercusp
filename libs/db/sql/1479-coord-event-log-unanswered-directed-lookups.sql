-- Migration 1479 — access paths for the index-driven unanswered-directed roster
-- (plan papercusp-performance-audit-2026-10-12, P-005; decision D-002).
--
-- WHY. fetchUnansweredDirected (packages/operator-core/lib/agent-tools/coordination/
-- unanswered-directed.ts) answers "which directed asks does each roster member still
-- owe a reply to?" for orient, inbox, fleet:assignments, the delivery-ladder sweep and
-- presence transitions. It used to MATERIALIZE every message ever authored by every
-- roster member (the roster_authored CTE) and anti-join the asks against it, so its
-- cost grew with the roster's whole authored history rather than with the asks.
-- MEASURED on the live box 2026-10-12 (pg_stat_statements queryid
-- -5961444489277740845): 26,430 calls at 2,880 ms mean; a 120 s window after the
-- earlier index work still averaged 2,914 ms. A 100-recipient EXPLAIN (ANALYZE,
-- BUFFERS): 1,237 ms, roster_authored alone 29,458 rows / 109,798 buffers.
--
-- The rewritten statement starts from the asks instead: it reads directed
-- expects-reply messages addressed to the roster, then probes for each ask's replies
-- by related_msg_id (existing coord_event_log_related_msg_id_idx), the ack ping-pong
-- original by msg_id (existing coord_event_log_msg_id_idx), and loose replies only for
-- recipients that still have open asks (existing coord_event_log_msgs_from_idx plus
-- the system-session index below). Same 100-recipient roster, identical result rows:
-- 240 ms with JIT off (the statement now runs under SET LOCAL jit = off), against
-- 1,281 ms for the old form in the same run.
--
-- THE TWO INDEXES. Both were first built by hand on the live box on 2026-10-12 while
-- measuring (19:42Z, CONCURRENTLY); this file makes them part of the schema so every
-- other database gets them, and is a no-op where they already exist.
--
--   coord_event_log_msgs_to_expects_reply_gin — the asks. The statement's directed
--   CTE requires body->>'expectsReply' = 'true', which implies this partial
--   predicate, so the planner can use it. It indexes only expects-reply messages:
--   1.1 MB against 11 MB for the unconditional coord_event_log_msgs_to_gin. Measured
--   (100 recipients): 5,119 index matches in 7.5 ms.
--
--   coord_event_log_msgs_from_system_session_idx — senders written as
--   'system:<lane>/<session>' count as <session> (identity.ts senderMatchesFilter).
--   The loose-reply lookup matches a recipient through this expression as well as
--   through body->>'from'; without this index that branch has no access path and
--   the planner falls back to a sequential scan of the whole table. 64 kB.
--
-- LOCKING. A plain (non-CONCURRENT) build: the runner wraps each file in a
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one (same trade-off as
-- migrations 753, 792 and 1476). On a database that does not already have them the
-- build holds a ShareLock on coord_event_log for one table scan; on the live box's
-- 3.2 GB table the hand builds took 21.5 s and 10.3 s. Where they exist (the live
-- box) IF NOT EXISTS makes this instant.
--
-- FORWARD-COMPAT. Additive only: no existing index, column or view changes, so the
-- currently-deployed release keeps working and simply gains the access paths.
CREATE INDEX IF NOT EXISTS coord_event_log_msgs_to_expects_reply_gin
  ON harness_shared.coord_event_log USING gin ((body -> 'to'))
  WHERE surface = 'messages' AND (body ->> 'expectsReply') = 'true';

CREATE INDEX IF NOT EXISTS coord_event_log_msgs_from_system_session_idx
  ON harness_shared.coord_event_log (
    workspace_id,
    substr(body ->> 'from', strpos(body ->> 'from', '/') + 1)
  )
  WHERE surface = 'messages'
    AND (body ->> 'from') LIKE 'system:%'
    AND strpos(body ->> 'from', '/') > 0;

COMMENT ON INDEX harness_shared.coord_event_log_msgs_to_expects_reply_gin IS
  'P-005 (papercusp-performance-audit-2026-10-12): the directed asks read by '
  'unanswered-directed.ts. Partial on expectsReply=true so it holds only asks.';

COMMENT ON INDEX harness_shared.coord_event_log_msgs_from_system_session_idx IS
  'P-005 (papercusp-performance-audit-2026-10-12): system:<lane>/<session> senders '
  'resolved to <session>, for the loose-reply lookup in unanswered-directed.ts.';
