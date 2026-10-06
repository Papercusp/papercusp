-- 1402 — desktop_sessions: admit scope='user' (a person's own cloud desktop).
--
-- Plan personal-cloud-desktop-2026-10-06 P-001 / D-001. Until now every desktop
-- belonged to an AGENT ('agent'), to a pot ('pot'), or was the product's own
-- desktop ('workspace'). A personal desktop is a fourth owner class:
--
--   'user' → scope_ref = the signed-in person's hosted userId. It runs as the
--            customer account on a hosted/BYOC workspace machine (the same
--            identity the person's hosted terminal uses), is never governed by
--            the agent idle reaper, and is openable only by that person.
--
-- One live personal desktop per person per workspace falls out of the existing
-- desktop_sessions_live_scope_uq index on (workspace_id, scope, scope_ref,
-- COALESCE(name, '')): a 'user' row never carries a name
-- (desktop_sessions_name_scope_ck keeps name agent-only), so the index admits
-- exactly one live row per (workspace, user).
--
-- FORWARD-COMPAT: this only WIDENS the scope CHECK; the release still serving
-- :3070 never writes scope='user', so every row it writes keeps satisfying the
-- replacement constraint, and nothing it reads depends on the constraint's name
-- or its member list.

ALTER TABLE harness_shared.desktop_sessions
  DROP CONSTRAINT IF EXISTS desktop_sessions_scope_ck;

ALTER TABLE harness_shared.desktop_sessions
  ADD CONSTRAINT desktop_sessions_scope_ck
    CHECK (scope IN ('pot', 'agent', 'workspace', 'user'));

COMMENT ON CONSTRAINT desktop_sessions_scope_ck ON harness_shared.desktop_sessions IS
  'Who owns a desktop: pot (scope_ref = hive slug), agent (scope_ref = ownerId), '
  'workspace (the product''s own desktop), user (scope_ref = the person''s hosted '
  'userId — a personal cloud desktop, migration 1402).';
