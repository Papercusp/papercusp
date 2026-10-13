-- consult-backed-parking-2026-10-12 P-006 (WI-6554700010009494): park progress for a
-- decision-review consult (a product-decision park opened by work_items:set_blocker).
--
-- The park's IDENTITY (work item, setter, default action, deadline, owner-authority
-- topic) rides consult_state.routing.cascade (D-013). Its PROGRESS lives here instead,
-- because the cascade's min-answers refill rewrites routing wholesale from an in-memory
-- copy, so a key appended to routing between that read and that write would be lost.
--
-- Shape (written only by consult/park-adapters.ts, appended with jsonb ||):
--   { outcomes:        [{ verdict, at, objectionId }],
--     parkerResponses: [{ kind: 'adopt'|'rebut', at, text, objectionId }],
--     ownerQuestionOpened: boolean,
--     ownerAnswer:     { at, text } | null }
-- NULL = a non-park consult, or a park with no progress yet.
ALTER TABLE harness_shared.consult_state
  ADD COLUMN IF NOT EXISTS park_state jsonb;

COMMENT ON COLUMN harness_shared.consult_state.park_state IS
  'consult-backed-parking P-006: decision-review park progress (outcomes, parker adopt/rebut responses, owner answer). Written by consult/park-adapters.ts; NULL for non-park consults.';
