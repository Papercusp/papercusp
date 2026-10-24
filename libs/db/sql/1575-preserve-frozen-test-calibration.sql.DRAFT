-- EI-26852061161501115: a frozen-test manifest is a durable reference to its
-- prospective failing calibration. Keep that exact receipt even after newer
-- runs exceed the history budget, including after successful item closure.
-- Reuse the existing retention function; unreferenced history keeps its limit.
CREATE OR REPLACE FUNCTION harness_shared.prune_test_runs(keep_per_file_branch integer DEFAULT 50)
RETURNS integer
LANGUAGE plpgsql
AS $function$
DECLARE
  deleted_count integer;
BEGIN
  WITH calibration_refs AS MATERIALIZED (
    SELECT w.workspace_id, w.harness_slug, red.run_id
      FROM harness_shared.work_items w
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(w.payload #> '{_frozenTests,redRunIds}') = 'array'
          THEN w.payload #> '{_frozenTests,redRunIds}' ELSE '[]'::jsonb END
      ) AS red(run_id)
     WHERE w.payload ? '_frozenTests'
  ), ranked AS (
    SELECT id, workspace_id, harness_slug,
           ROW_NUMBER() OVER (
             PARTITION BY file_path, COALESCE(branch, '__null__')
             ORDER BY finished_at DESC NULLS LAST, id DESC
           ) AS rn
      FROM harness_shared.test_runs
  )
  DELETE FROM harness_shared.test_runs
   WHERE id IN (
     SELECT r.id FROM ranked r
      WHERE r.rn > keep_per_file_branch
        AND NOT EXISTS (
          SELECT 1 FROM calibration_refs c
           WHERE c.workspace_id = r.workspace_id
             AND c.harness_slug = r.harness_slug
             AND c.run_id = r.id::text
        )
   );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$function$;
