-- 284-harness-plans-initiative.sql
--
-- shared-hive-collaboration-2026-06-14 P-015 (initiative grouping field, D-002):
-- a single free-text `initiative` label on a plan that groups related plans,
-- surfaced as a filter facet in the my/others/all saved-views (P-002). Grouping
-- is ONE metadata field — explicitly NOT a branch/worktree/PR-hierarchy model.
--
-- A derived frontmatter-index column mirroring `owner`: recomputed from the
-- plan's canonical `content` frontmatter on every write (deriveIndexFromContent),
-- so `plans:list` stays parse-free (audit P-042). Federates the same way every
-- other scalar does — it rides the `content` change that always accompanies an
-- initiative edit, and the per-part recompose / whole-blob projection re-derive
-- it from the recomposed frontmatter on the receive side.
--
-- Nullable, additive — plans without an initiative stay NULL.
-- Idempotent: ADD COLUMN IF NOT EXISTS.

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS initiative text;

COMMIT;
