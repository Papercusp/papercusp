-- P010: extend the existing run ledger; an intent survives snapshot expiry and
-- process death. A committed start is never assumed to have had no effects.
ALTER TABLE harness_shared.testing_run_snapshots
  ADD COLUMN IF NOT EXISTS native_proof_input jsonb,
  ADD COLUMN IF NOT EXISTS native_proof_events jsonb;

CREATE OR REPLACE FUNCTION harness_shared.protect_native_proof_run_input()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  old_count integer;
  new_count integer;
  next_kind text;
  expected_kind text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.native_proof_input IS NOT NULL THEN
      RAISE EXCEPTION 'native proof admission is durable; retain its original intent'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.native_proof_input IS NULL AND NEW.native_proof_input IS NOT NULL THEN
      RAISE EXCEPTION 'native proof input must be inserted before allocation'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.native_proof_input IS NOT NULL THEN
      IF ROW(NEW.run_id, NEW.kind, NEW.label, NEW.file_path, NEW.command, NEW.task_id,
          NEW.started_at, NEW.native_proof_input) IS DISTINCT FROM
        ROW(OLD.run_id, OLD.kind, OLD.label, OLD.file_path, OLD.command, OLD.task_id,
          OLD.started_at, OLD.native_proof_input) THEN
        RAISE EXCEPTION 'native proof launch input is immutable' USING ERRCODE = '23514';
      END IF;
      IF NEW.native_proof_events IS NOT DISTINCT FROM OLD.native_proof_events THEN RETURN NEW; END IF;
      old_count := jsonb_array_length(OLD.native_proof_events);
      new_count := jsonb_array_length(NEW.native_proof_events);
      IF (new_count = old_count + 1 AND (NEW.native_proof_events - old_count) = OLD.native_proof_events) IS NOT TRUE THEN
        RAISE EXCEPTION 'native proof events are append-only' USING ERRCODE = '23514';
      END IF;
      expected_kind := (ARRAY['reserved','started','installed','built','runtime','trace','sealed','readback'])[new_count];
      next_kind := NEW.native_proof_events->old_count->>'kind';
      IF expected_kind IS NULL OR next_kind IS DISTINCT FROM expected_kind THEN
        RAISE EXCEPTION 'native proof event order or single-start violation' USING ERRCODE = '23514';
      END IF;
      IF next_kind = 'readback' AND
        (NEW.native_proof_events->old_count->>'receiptSha256') IS DISTINCT FROM
        (OLD.native_proof_events->(old_count - 1)->>'receiptSha256') THEN
        RAISE EXCEPTION 'native proof seal readback digest mismatch' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF NEW.native_proof_input IS NULL THEN
    IF NEW.native_proof_events IS NOT NULL THEN
      RAISE EXCEPTION 'native proof events require their original intent' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (jsonb_typeof(NEW.native_proof_input) = 'object'
      AND NEW.native_proof_input->>'schemaVersion' = '1'
      AND NEW.native_proof_input->>'fingerprint' ~ '^[a-f0-9]{64}$'
      AND NEW.run_id = 'native-proof-' || (NEW.native_proof_input->>'fingerprint')
      AND jsonb_typeof(NEW.native_proof_input->'input') = 'object'
      AND jsonb_typeof(NEW.native_proof_events) = 'array'
      AND NEW.native_proof_events->0->>'kind' = 'reserved') IS NOT TRUE THEN
    RAISE EXCEPTION 'invalid native proof launch input' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND jsonb_array_length(NEW.native_proof_events) <> 1 THEN
    RAISE EXCEPTION 'native proof must begin with an unstarted reservation' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.native_proof_events) event
    WHERE event->>'fingerprint' IS DISTINCT FROM NEW.native_proof_input->>'fingerprint') THEN
    RAISE EXCEPTION 'native proof observation detached from launch intent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS testing_run_snapshots_native_proof_guard ON harness_shared.testing_run_snapshots;
CREATE TRIGGER testing_run_snapshots_native_proof_guard
  BEFORE INSERT OR UPDATE OR DELETE ON harness_shared.testing_run_snapshots
  FOR EACH ROW EXECUTE FUNCTION harness_shared.protect_native_proof_run_input();

COMMENT ON COLUMN harness_shared.testing_run_snapshots.native_proof_input IS
  'Content-addressed prelaunch input on the existing ledger. Immutable; review receipts support admission but storage alone does not establish review authority.';
COMMENT ON COLUMN harness_shared.testing_run_snapshots.native_proof_events IS
  'Ordered append-only reservation/start/installed/build/runtime/trace/seal/readback observations on one intent. A started or unknown attempt cannot auto-relaunch.';
