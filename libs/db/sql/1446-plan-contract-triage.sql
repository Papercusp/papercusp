-- 1446 — per-plan contract-triage dispositions (verification-system-improvements-2026-10-10 P-004).
--
-- Every active plan without a requirement contract ends in exactly one recorded disposition:
-- a backfilled contract (harness_plans.acceptance_bar_set_hash, no row here), a recorded
-- EXEMPTION, or a CLOSURE with its own per-plan reason. This table carries the last two.
--
-- Why a table and not an existing surface:
--   * harness_plans.properties is TYPED (plans:set-property refuses an undeclared key), and the
--     ~105 legacy plans in scope declare no property schema;
--   * plan_revisions.rationale is a free-text note on whatever revision a status write made, so
--     it cannot tell a triage closure from any other status move, nor carry an exemption;
--   * harness_plan_status carries no reason column (and is unpopulated).
-- measureContractTriage (packages/operator-core/lib/agent-tools/plans/contract-triage.ts) reads
-- this table; the verification.health cell imports that function (plan Decision D-018).

CREATE TABLE IF NOT EXISTS harness_shared.plan_contract_triage (
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  plan_slug    text NOT NULL,
  disposition  text NOT NULL CHECK (disposition IN ('exempt', 'closed')),
  -- The plan's OWN reason. A shared bulk reason is counted as missing by the measurement.
  reason       text NOT NULL CHECK (length(btrim(reason)) > 0),
  evidence_ref text,
  -- The status the triage moved the plan to (closed only), for audit.
  closed_to_status text,
  recorded_by  text NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, plan_slug)
);

COMMENT ON TABLE harness_shared.plan_contract_triage IS
  'P-004 contract triage: one row per plan that was exempted from, or closed instead of, a requirement contract. Read by measureContractTriage (contract-triage.ts).';
