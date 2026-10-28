-- 1603: a plan decision's provenance is a field, not a text tag in its body.
--
-- one-work-graph-structured-holds-2026-10-26 P-018 (WI-6554700010030925), shape fixed by
-- one-work-graph-structured-holds-2026-10-26#D-012.
--
-- Separate from harness_shared.plan_decisions on purpose: that table is a projection of the plan
-- body, deleted and re-inserted on every plan write (plan-index-rows.ts writePlanIndexRows), so a
-- column there that only the decision tools write would be wiped by the next unrelated edit.
-- Nothing in this table is derived from body text. Rows are written by plans:add-decision and
-- plans:set-decision-body (source 'write') and by the P-019 conversion (source 'conversion').
--
-- kind 'owner' records the owner turn the ruling came from, and the verdict the turn-provenance
-- ledger gave that turn when the row was written; the tools refuse an owner row whose turn does not
-- resolve to an owner verdict. kind 'agent' records no turn. agent_id is always the agent that
-- recorded the row, taken from its identity, never from a caller argument.
CREATE TABLE IF NOT EXISTS harness_shared.plan_decision_provenance (
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  plan_slug text NOT NULL,
  decision_id text NOT NULL CHECK (decision_id ~ '^D-[0-9]{3,}$'),
  kind text NOT NULL CHECK (kind IN ('owner', 'agent')),
  owner_turn_ref text,
  owner_turn_verdict text CHECK (owner_turn_verdict IN ('owner-typed', 'owner-turn', 'owner-dialog')),
  agent_id text NOT NULL CHECK (btrim(agent_id) <> ''),
  source text NOT NULL CHECK (source IN ('write', 'conversion')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, plan_slug, decision_id),
  CONSTRAINT plan_decision_provenance_kind_shape CHECK (
    (kind = 'owner' AND owner_turn_ref IS NOT NULL AND btrim(owner_turn_ref) <> '' AND owner_turn_verdict IS NOT NULL)
    OR (kind = 'agent' AND owner_turn_ref IS NULL AND owner_turn_verdict IS NULL)
  )
);

COMMENT ON TABLE harness_shared.plan_decision_provenance IS
  'Who a plan decision came from: an owner turn (verified owner verdict) or the recording agent. '
  'Not derived from the plan body; written only by the decision tools and the P-019 conversion. '
  'one-work-graph-structured-holds-2026-10-26#D-012.';
