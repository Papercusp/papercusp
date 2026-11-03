-- 1616: distinguish primary transcript-byte progress from auxiliary state-row
-- writes (counts/parts backfills) so the ingest watchdog cannot treat a fresh
-- updated_at as evidence that byte_offset moved (EI-27229357030009265).
--
-- Existing rows have no per-write history, so updated_at is only a migration
-- baseline. From this migration onward the trigger preserves the timestamp for
-- same-offset writes and refreshes it whenever the primary cursor changes.
ALTER TABLE harness_shared.session_ingest_state
  ADD COLUMN IF NOT EXISTS byte_offset_changed_at timestamptz;

UPDATE harness_shared.session_ingest_state
   SET byte_offset_changed_at = updated_at
 WHERE byte_offset_changed_at IS NULL;

ALTER TABLE harness_shared.session_ingest_state
  ALTER COLUMN byte_offset_changed_at SET DEFAULT now();

CREATE OR REPLACE FUNCTION harness_shared.stamp_session_ingest_byte_offset_changed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.byte_offset_changed_at := COALESCE(NEW.byte_offset_changed_at, now());
  ELSIF NEW.byte_offset IS DISTINCT FROM OLD.byte_offset THEN
    NEW.byte_offset_changed_at := now();
  ELSE
    NEW.byte_offset_changed_at := OLD.byte_offset_changed_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS session_ingest_state_byte_offset_changed_at
  ON harness_shared.session_ingest_state;

CREATE TRIGGER session_ingest_state_byte_offset_changed_at
  BEFORE INSERT OR UPDATE ON harness_shared.session_ingest_state
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.stamp_session_ingest_byte_offset_changed_at();

COMMENT ON COLUMN harness_shared.session_ingest_state.byte_offset_changed_at IS
  'Timestamp of the last primary byte_offset change; auxiliary state-row writes do not refresh it and the ingest-lag watchdog uses it as per-file progress evidence (EI-27229357030009265).';
