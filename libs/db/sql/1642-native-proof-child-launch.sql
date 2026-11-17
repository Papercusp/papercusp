-- P010: child authorization and start extend the original run, not its key.
ALTER TABLE harness_shared.testing_run_snapshots
  ADD COLUMN IF NOT EXISTS native_proof_child_launch jsonb;

CREATE OR REPLACE FUNCTION harness_shared.protect_native_proof_child_launch()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  child jsonb := NEW.native_proof_child_launch;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF child IS NOT NULL THEN
      RAISE EXCEPTION 'native proof child requires its committed built parent' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF child IS NOT DISTINCT FROM OLD.native_proof_child_launch THEN
    IF child IS NOT NULL AND child->>'state' <> 'started'
      AND jsonb_array_length(NEW.native_proof_events) > 4 THEN
      RAISE EXCEPTION 'native proof runtime requires child start' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.native_proof_input IS NOT NULL
    AND jsonb_array_length(NEW.native_proof_events) = 4
    AND NEW.native_proof_events->3->>'kind' = 'built'
    AND jsonb_typeof(child) = 'object'
    AND child->>'fingerprint' = NEW.native_proof_input->>'fingerprint'
    AND length(child->>'entryPoint') > 0
    AND child->>'entryPointSha256' ~ '^[a-f0-9]{64}$'
    AND child->>'entryPointSha256' = NEW.native_proof_input->'input'->'prerequisiteSources'->>(child->>'entryPoint')
    AND (child - 'fingerprint' - 'entryPoint' - 'entryPointSha256' - 'state') = '{}'::jsonb) IS NOT TRUE THEN
    RAISE EXCEPTION 'native proof child detached from reviewed built intent' USING ERRCODE = '23514';
  END IF;
  IF OLD.native_proof_child_launch IS NULL THEN
    IF child->>'state' IS DISTINCT FROM 'authorized' THEN
      RAISE EXCEPTION 'native proof child must be authorized before fork' USING ERRCODE = '23514';
    END IF;
  ELSIF ((OLD.native_proof_child_launch->>'state') = 'authorized'
    AND child->>'state' = 'started'
    AND (child - 'state') = (OLD.native_proof_child_launch - 'state')) IS NOT TRUE THEN
    RAISE EXCEPTION 'native proof child start is immutable and single use' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS testing_run_snapshots_native_child_guard ON harness_shared.testing_run_snapshots;
CREATE TRIGGER testing_run_snapshots_native_child_guard
  BEFORE INSERT OR UPDATE ON harness_shared.testing_run_snapshots
  FOR EACH ROW EXECUTE FUNCTION harness_shared.protect_native_proof_child_launch();
