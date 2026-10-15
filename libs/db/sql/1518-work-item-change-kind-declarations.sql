-- 1518-work-item-change-kind-declarations.sql
-- P-001 (plan change-kind-declared-proof-2026-10-15, EI-26049391397809141; decisions D-001..D-003).
--
-- The agent working a work-item declares which kinds of change it is making (ui, service,
-- migration, background-job, logic, docs, config, test-only, no-code-change). A successful
-- close then has to carry the proof that kind needs. Each row here is one declaration, made at
-- work_items:create (with assign_to), work_items:claim, work_items:checkpoint or
-- work_items:complete. The newest row for an item is its current declaration; older rows are
-- its history, so a narrowed or late declaration stays visible.
--
-- Kinds are checked in code against the bundled catalog
-- (packages/operator-core/lib/change-kind-catalog.ts), not by a CHECK constraint, so the
-- catalog has a single source.
--
-- Additive only: one new table and one index. Nothing the deployed release reads changes.

CREATE TABLE IF NOT EXISTS harness_shared.work_item_change_kind_declarations (
  id            bigserial   PRIMARY KEY,
  workspace_id  text        NOT NULL CHECK (length(btrim(workspace_id)) > 0),
  feature_id    text        NOT NULL CHECK (length(btrim(feature_id)) > 0),
  kinds         text[]      NOT NULL CHECK (cardinality(kinds) > 0),
  step          text        NOT NULL CHECK (step IN ('create', 'claim', 'checkpoint', 'complete')),
  declared_by   text        NOT NULL CHECK (length(btrim(declared_by)) > 0),
  declared_at   timestamptz NOT NULL DEFAULT now(),
  reason        text        CHECK (reason IS NULL OR length(btrim(reason)) > 0)
);

COMMENT ON TABLE harness_shared.work_item_change_kind_declarations IS
  'Agent-declared change kinds per work-item. Newest row per (workspace_id, feature_id) is current; older rows are history. Kinds validated in code against change-kind-catalog.ts.';

CREATE INDEX IF NOT EXISTS work_item_change_kind_declarations_item_idx
  ON harness_shared.work_item_change_kind_declarations (workspace_id, feature_id, declared_at DESC, id DESC);
