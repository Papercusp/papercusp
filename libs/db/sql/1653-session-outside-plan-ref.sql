-- Outside-plan brief R1 / WI-6554700010067074: a trusted, durable session binding.
ALTER TABLE harness_shared.adv_sessions ADD COLUMN outside_plan_ref text;
ALTER TABLE harness_shared.adv_sessions ADD CONSTRAINT adv_sessions_outside_plan_ref_valid
  CHECK (outside_plan_ref IS NULL OR (char_length(outside_plan_ref) BETWEEN 1 AND 200 AND plan_slug IS NULL));
COMMENT ON COLUMN harness_shared.adv_sessions.outside_plan_ref IS
  'Opaque outside system item label, supplied at trusted launch; mutually exclusive with plan_slug.';
