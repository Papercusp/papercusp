-- EI-28346050217184087: immutable mutation evidence includes its calibration
-- controls, not only the directly bound mutant. Extend the existing DELETE
-- guard so every pruning caller preserves that reference closure. Historical
-- missing rows cannot be reconstructed by this migration.
CREATE INDEX IF NOT EXISTS test_runs_bound_mutation_probe
  ON harness_shared.test_runs (
    workspace_id, file_path,
    (execution_details #>> '{mutation,probeInvocationId}'),
    (execution_details #>> '{mutation,subjectBeforeSha256}')
  )
  WHERE source = 'mutation-probe'
    AND execution_details #>> '{mutation,leg}' = 'mutant';

CREATE INDEX IF NOT EXISTS spec_evidence_bindings_mutation_controls
  ON harness_shared.spec_evidence_bindings USING gin (details jsonb_path_ops)
  WHERE evidence_kind = 'mutation';

CREATE OR REPLACE FUNCTION harness_shared.preserve_spec_bound_test_runs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM harness_shared.spec_evidence_bindings b
     WHERE b.test_run_id = OLD.id
  ) THEN
    RETURN NULL;
  END IF;

  IF OLD.source IS DISTINCT FROM 'mutation-probe'
     OR OLD.status IS DISTINCT FROM 'pass' THEN
    RETURN OLD;
  END IF;

  -- Match the existing spec-evidence reader's calibration identity, including
  -- controls that the probe left harness-NULL when only the mutant was adopted.
  IF OLD.execution_details #>> '{mutation,leg}' IN ('baseline', 'copy-baseline')
     AND EXISTS (
       SELECT 1 FROM harness_shared.test_runs mutant
       JOIN harness_shared.spec_evidence_bindings b ON b.test_run_id = mutant.id
        WHERE b.evidence_kind = 'mutation'
          AND b.workspace_id = OLD.workspace_id
          AND mutant.workspace_id = OLD.workspace_id
          AND (OLD.harness_slug IS NULL OR OLD.harness_slug = mutant.harness_slug)
          AND mutant.file_path = OLD.file_path
          AND mutant.source = 'mutation-probe'
          AND mutant.execution_details #>> '{mutation,leg}' = 'mutant'
          AND mutant.execution_details #>> '{mutation,probeInvocationId}'
              = OLD.execution_details #>> '{mutation,probeInvocationId}'
          AND mutant.execution_details #>> '{mutation,subjectBeforeSha256}'
              = OLD.execution_details #>> '{mutation,subjectBeforeSha256}'
     ) THEN
    RETURN NULL;
  END IF;

  -- Older probes may lack descriptors but carry validated typed control IDs.
  -- JSON containment keeps those lookups indexable and avoids unsafe casts of
  -- arbitrary historical details. A foreign workspace/harness cannot pin a row.
  IF EXISTS (
    SELECT 1 FROM harness_shared.spec_evidence_bindings b
    JOIN harness_shared.test_runs mutant ON mutant.id = b.test_run_id
     WHERE b.evidence_kind = 'mutation'
       AND b.workspace_id = OLD.workspace_id
       AND mutant.workspace_id = OLD.workspace_id
       AND (OLD.harness_slug IS NULL OR OLD.harness_slug = mutant.harness_slug)
       AND mutant.source = 'mutation-probe'
       AND b.details #>> '{causalControls,mutantTestRunId}' = mutant.id::text
       AND (
         b.details @> jsonb_build_object('causalControls', jsonb_build_object('baselineTestRunId', OLD.id))
         OR b.details @> jsonb_build_object('causalControls', jsonb_build_object('copyBaselineTestRunId', OLD.id))
       )
  ) THEN
    RETURN NULL;
  END IF;
  RETURN OLD;
END;
$fn$;
