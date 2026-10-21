-- 1542 — plan items may declare a namespaced item type
-- (plan-item-types-registry-cupboard-2026-10-20 P-002, requirement R-4).
--
-- The `deliverable:` keyword on a plan-item line now accepts any namespaced item-type slug
-- (`acme/legal-review`) as well as today's six built-in kinds. The parser checks grammar only;
-- policy (which verification modules apply) lives in the resolver, which fails safe to the full
-- module catalog when the type is not registered. This migration widens the column's CHECK to
-- the same grammar the parser and the registry use (TYPE_ID_PATTERN in
-- packages/operator-core/lib/plan-types/definitions.ts), so a namespaced slug can be stored.
--
-- FORWARD-COMPAT: the currently deployed release writes only the six built-in kinds, which the widened CHECK still admits, and it never relies on the CHECK refusing anything else.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'plan_items_deliverable_check'
       AND conrelid = 'harness_shared.plan_items'::regclass
  ) THEN
    ALTER TABLE harness_shared.plan_items DROP CONSTRAINT plan_items_deliverable_check;
  END IF;
  ALTER TABLE harness_shared.plan_items
    ADD CONSTRAINT plan_items_deliverable_check
    CHECK (
      deliverable IS NULL
      OR deliverable IN ('code', 'doc', 'decision', 'research', 'operation', 'artifact')
      OR deliverable ~ '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$'
    );
END
$$;

COMMENT ON COLUMN harness_shared.plan_items.deliverable IS
  'Declared item type from the item-line deliverable: keyword: a built-in kind (code | doc | decision | research | operation | artifact) or a namespaced item-type slug (<namespace>/<name>). NULL = undeclared; the resolver uses the plan type default. plan-item-types-registry-cupboard-2026-10-20 P-002.';
