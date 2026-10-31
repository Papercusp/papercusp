-- Extend canonical code links with initial implementation intent; legacy links remain readable.
ALTER TABLE harness_shared.plan_item_anchors
  ADD COLUMN IF NOT EXISTS change_intent jsonb;
