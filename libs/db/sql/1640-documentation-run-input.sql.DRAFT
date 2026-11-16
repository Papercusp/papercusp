-- P-017: retain documentation launch input on the existing detached-run ledger.
-- This stores input, not capture admission or acceptance authority. Ordinary
-- snapshots retain their existing update and retention policy.
ALTER TABLE harness_shared.testing_run_snapshots
  ADD COLUMN IF NOT EXISTS documentation_input jsonb;

DO $constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'harness_shared.testing_run_snapshots'::regclass
      AND conname = 'testing_run_snapshots_documentation_input_ck') THEN
    ALTER TABLE harness_shared.testing_run_snapshots
      ADD CONSTRAINT testing_run_snapshots_documentation_input_ck CHECK (
        documentation_input IS NULL OR (
          jsonb_typeof(documentation_input) = 'object'
          AND documentation_input->>'schemaVersion' = '1'
          AND documentation_input->>'inputSha256' ~ '^[a-f0-9]{64}$'
          AND documentation_input->'input'->>'runId' = run_id
          AND documentation_input->'input'->>'kind' = kind
          AND documentation_input->'input'->>'label' = label
          AND documentation_input->'input'->'filePath' = COALESCE(to_jsonb(file_path), 'null'::jsonb)
          AND documentation_input->'input'->'command' = command
          AND documentation_input->'input'->'taskId' = COALESCE(to_jsonb(task_id), 'null'::jsonb)
          AND documentation_input->'input'->'startedAt' = to_jsonb(extract(epoch FROM started_at) * 1000)
          AND jsonb_typeof(documentation_input->'input'->'source') = 'object'
          AND jsonb_typeof(documentation_input->'input'->'configuration') = 'object'
        ) IS TRUE
      );
  END IF;
END
$constraint$;

CREATE OR REPLACE FUNCTION harness_shared.protect_documentation_run_input()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD.documentation_input IS NULL AND NEW.documentation_input IS NOT NULL THEN
    RAISE EXCEPTION 'documentation input must be inserted before launch'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.documentation_input IS NOT NULL AND
    ROW(NEW.run_id, NEW.kind, NEW.label, NEW.file_path, NEW.command, NEW.task_id,
        NEW.started_at, NEW.documentation_input) IS DISTINCT FROM
    ROW(OLD.run_id, OLD.kind, OLD.label, OLD.file_path, OLD.command, OLD.task_id,
        OLD.started_at, OLD.documentation_input) THEN
    RAISE EXCEPTION 'documentation run input is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS testing_run_snapshots_documentation_input_guard
  ON harness_shared.testing_run_snapshots;
CREATE TRIGGER testing_run_snapshots_documentation_input_guard
  BEFORE UPDATE ON harness_shared.testing_run_snapshots
  FOR EACH ROW EXECUTE FUNCTION harness_shared.protect_documentation_run_input();

COMMENT ON COLUMN harness_shared.testing_run_snapshots.documentation_input IS
  'P-017: immutable canonical launch input and SHA256. Insert in the future capture-admission transaction; presence alone grants no admission or acceptance authority. Retained beyond ordinary transient snapshots.';
