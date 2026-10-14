-- 1507 — spec-conformance sweep watermark (spec-driven-tooling-integration-2026-10-05 P-031, R-23).
--
-- `system:spec-conformance-sweep` runs a plan's deterministic conformance checks when the
-- plan's footprint changed, a plan-linked work-item transitioned, or the per-plan interval
-- elapsed. This table is the per-plan watermark that makes those three triggers decidable:
--
--   last_run_at         when the sweep last ran this plan (interval trigger)
--   footprint_head_sha  the repo head the footprint reconcile last scanned up to (commit trigger)
--   last_transition_at  max(work_items.state_changed_at) over the plan's linked work-items,
--                       read AFTER the run so the sweep's own writes never re-trigger it
--   last_triggers       why the last run fired (diagnostics only)
--   last_outcome        a bounded summary of the last run (counts, alarm actions, problems)
--
-- One row per (workspace, harness, plan). Pure expand: a new table, nothing existing changes.

CREATE TABLE IF NOT EXISTS harness_shared.spec_conformance_state (
  workspace_id        text        NOT NULL,
  harness_slug        text        NOT NULL,
  plan_slug           text        NOT NULL,
  last_run_at         timestamptz NOT NULL,
  footprint_head_sha  text,
  last_transition_at  timestamptz,
  last_triggers       text[]      NOT NULL DEFAULT '{}',
  last_outcome        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, plan_slug)
);

COMMENT ON TABLE harness_shared.spec_conformance_state IS
  'Per-plan watermark for system:spec-conformance-sweep (P-031/R-23): last run, footprint head sha, last linked work-item transition, last outcome summary.';
COMMENT ON COLUMN harness_shared.spec_conformance_state.last_transition_at IS
  'max(work_items.state_changed_at) over source_plan_slug-linked items, observed after the run (so sweep-authored writes cannot self-trigger).';
