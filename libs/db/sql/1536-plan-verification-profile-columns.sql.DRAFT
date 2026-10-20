-- 1536: plan verification profile + per-item deliverable kind.
-- Plan plan-verification-profiles-2026-10-17 P-002 (WI-6554700010017301), decisions D-001 and D-005.
--
-- verification_profile is machine state, like template_data: plans:new stamps it (declared, or the
-- harness default), content writes preserve it, and the TypeScript backfill fills existing rows
-- without rewriting plan content. NULL means "not yet stamped": the resolver then falls back to the
-- harness default, so the column can land before the backfill runs.
--
-- verification_profile_source records how the value was set. P-005's anti-escape guard needs it to
-- tell a declared profile from a defaulted one.
--
-- plan_items.deliverable mirrors the item-line `deliverable:` keyword, the same way importance is
-- mirrored. NULL means undeclared: the resolver infers the kind from today's signals.
--
-- Additive only (nullable columns + CHECK constraints that NULL satisfies); the deployed release
-- never reads these columns, so no forward-compat acknowledgment is needed.

ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS verification_profile text,
  ADD COLUMN IF NOT EXISTS verification_profile_source text;

ALTER TABLE harness_shared.plan_items
  ADD COLUMN IF NOT EXISTS deliverable text;

-- Add each CHECK only when missing, so a re-run is a no-op without any DROP.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'harness_plans_verification_profile_check'
       AND conrelid = 'harness_shared.harness_plans'::regclass
  ) THEN
    ALTER TABLE harness_shared.harness_plans
      ADD CONSTRAINT harness_plans_verification_profile_check
      CHECK (verification_profile IS NULL OR verification_profile IN ('coding', 'general'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'harness_plans_verification_profile_source_check'
       AND conrelid = 'harness_shared.harness_plans'::regclass
  ) THEN
    ALTER TABLE harness_shared.harness_plans
      ADD CONSTRAINT harness_plans_verification_profile_source_check
      CHECK (
        verification_profile_source IS NULL
        OR verification_profile_source IN ('declared', 'harness-default', 'backfill')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'plan_items_deliverable_check'
       AND conrelid = 'harness_shared.plan_items'::regclass
  ) THEN
    ALTER TABLE harness_shared.plan_items
      ADD CONSTRAINT plan_items_deliverable_check
      CHECK (deliverable IS NULL OR deliverable IN ('code', 'doc', 'decision', 'research', 'operation', 'artifact'));
  END IF;
END
$$;

COMMENT ON COLUMN harness_shared.harness_plans.verification_profile IS
  'Plan verification profile (coding | general): the default deliverable kind for the plan items. NULL = not yet stamped; resolver uses the harness default. plan-verification-profiles-2026-10-17 D-001.';
COMMENT ON COLUMN harness_shared.harness_plans.verification_profile_source IS
  'How verification_profile was set: declared (plans:new arg), harness-default (undeclared, from the harness blueprint), backfill (migration 1536 backfill from audit history).';
COMMENT ON COLUMN harness_shared.plan_items.deliverable IS
  'Declared deliverable kind from the item-line deliverable: keyword (code | doc | decision | research | operation | artifact). NULL = undeclared; resolver infers it.';
