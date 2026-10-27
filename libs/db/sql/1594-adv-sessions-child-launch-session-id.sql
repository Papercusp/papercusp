-- 1594: adv_sessions.child_launch_session_id — the native session id the CURRENT
-- child process was launched with, kept as an accepted alias after an in-place
-- context reset rotates session_id (WI-6554700010030031).
--
-- A cold-loop RESET-CONTEXT `/clear` rotates Claude's native session id INSIDE the
-- same child process. psu-pty-host re-anchors session_id to the rotated id so the
-- hook / turn-stamp / context-estimate consumers (which read the live id) stay
-- correct (EI-27033376159376450). But the child's papercusp-su MCP header and every
-- shell it spawns carry PAPERCUSP_NATIVE_SESSION_ID, fixed at launch and immutable
-- in a running process. Without an alias, every native MCP call from that child is
-- refused `superuser_foreign_native_session` until the next respawn.
--
-- Additive, nullable, no default: the currently-deployed release neither reads nor
-- writes it, and a NULL keeps today's single-id verification.
ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS child_launch_session_id text;

COMMENT ON COLUMN harness_shared.adv_sessions.child_launch_session_id IS
  'Native session id the current child process was launched with, accepted by the native-session verifier as an alias of session_id after an in-place context reset rotates session_id (WI-6554700010030031). Written by reanchorAdvSessionNativeId; NULL means only session_id is accepted.';
