-- 1407-email-draft-proposal-agent-audience.sql — plan app-agent-tasks-durable-execution-2026-10-06
-- D-016 (WI-10006864)
--
-- email-draft-proposal becomes AGENT-audience work.
--
-- Migration 1318 classified it work/human (enterprise-data-sources-2026-10-01 D-007).
-- That matched the retired Gmail-binding flow, where the item waited in the owner's
-- Queue for the owner to act on. Email's durable draft operations
-- (email/.papercusp/blueprint.yaml, execution { kind: agent, role: email-draft-worker })
-- execute the item with an agent, and the owner reviews and sends the draft in the
-- Email app from the operation's result. The kind's own datatype blueprint
-- (email/blueprints/email-draft-proposal) defines the same agent worker. A
-- human-audience row is never agent-claimable (work_item_is_agent_work, the claim
-- UPDATE's category gate), so no Email draft could ever execute. The sibling proposal
-- kinds crm-proposal and email-triage-proposal are already agent-audience.
--
-- Existing work_items rows keep their stamped audience: nature_stamp_from_registry_trg
-- fires only when item_kind, workspace_id, nature or audience change. The open legacy
-- item held for the owner (email WI-10000680, plan D-015) therefore stays human.
-- New workspaces copy nature/audience from this seeded row (cupboard
-- install-datatype-io), so they inherit the change.
--
-- Overturn path (plan D-016): set the row back to 'human' in a later migration and route
-- Email drafts through a separate agent-audience kind instead.

UPDATE harness_shared.datatype_registry
   SET audience   = 'agent',
       updated_at = now()
 WHERE id = 'email-draft-proposal'
   AND nature = 'work'
   AND audience IS DISTINCT FROM 'agent';
