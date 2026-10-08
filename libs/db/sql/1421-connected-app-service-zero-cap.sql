-- A zero-cap service key is a useful read/cancel-only credential: P-011's seat refuses every
-- new LLM-running call when spent >= cap, while non-LLM tools remain available.
-- FORWARD-COMPAT: deployed :3070 still validates service caps at >=1, so it cannot create zero-cap rows; the relaxed constraint only takes effect for callers after their code update ships.
DO $$
BEGIN
  IF to_regclass('harness_shared.connected_apps') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE harness_shared.connected_apps
    DROP CONSTRAINT IF EXISTS connected_apps_spend_cap_positive,
    DROP CONSTRAINT IF EXISTS connected_apps_spend_cap_nonnegative,
    ADD CONSTRAINT connected_apps_spend_cap_nonnegative
      CHECK (spend_cap_cents IS NULL OR spend_cap_cents >= 0);
END
$$;
