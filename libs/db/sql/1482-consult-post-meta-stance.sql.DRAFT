-- 1482: consult_post_meta.stance — a reviewer's stance on a decision-review consult
-- (plan consult-backed-parking-2026-10-12, P-004, bars R-4 / R-15).
--
-- A product-decision park (work_items:set_blocker, P-005) opens a get_feedback
-- consult whose persisted routing carries cascade.flavor = 'decision-review'.
-- Every responder reply on such a consult must declare a stance:
--   { position: 'support' | 'no-view' }
--   { position: 'object', basis: 'alternative',     reason, alternative }
--   { position: 'object', basis: 'hazard',          reason, evidence[] }
--   { position: 'object', basis: 'owner-authority', topic, reason? }
-- The shape is validated in code (lib/consult/decision-review.ts); this column
-- stores it so the park resolver (P-006) can find a standing objection.
-- Additive and nullable: ordinary consult posts keep stance NULL.

ALTER TABLE harness_shared.consult_post_meta
  ADD COLUMN IF NOT EXISTS stance jsonb;

COMMENT ON COLUMN harness_shared.consult_post_meta.stance IS
  'Decision-review reviewer stance (consult-backed-parking P-004): {position: support|object|no-view, basis?, reason?, alternative?, evidence?, topic?}. NULL on every non-decision-review post.';
