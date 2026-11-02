-- Successful local start proof, with no backfill from the retired op_status.
ALTER TABLE harness_shared.harness_plans ADD COLUMN IF NOT EXISTS execution_start_revision_seq integer;

CREATE OR REPLACE FUNCTION harness_shared.fence_plan_execution_start()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE preserved jsonb; issued jsonb; old_inputs jsonb; new_inputs jsonb; generated_columns text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.execution_start_revision_seq := NULL;
    RETURN NEW;
  END IF;
  preserved := COALESCE(NULLIF(current_setting('papercusp.execution_progress', true), ''), 'null')::jsonb;
  issued := COALESCE(NULLIF(current_setting('papercusp.execution_start', true), ''), 'null')::jsonb;
  -- Generated fields are NULL in NEW during BEFORE triggers, and are derived
  -- projections rather than structured execution inputs (including on Now edits).
  SELECT COALESCE(array_agg(attname::text), ARRAY[]::text[]) INTO generated_columns
    FROM pg_attribute WHERE attrelid=TG_RELID AND attgenerated<>'' AND NOT attisdropped;
  old_inputs := to_jsonb(OLD) - ARRAY['execution_start_revision_seq','content','content_hash',
    'version','updated_at','updated','status','op_status','op_updated_at','op_started_at',
    'items','decisions','title','now_state','now_next','now_note','now_note_version','now_note_updated_at','fed_ts','fed_hlc','origin'];
  new_inputs := to_jsonb(NEW) - ARRAY['execution_start_revision_seq','content','content_hash',
    'version','updated_at','updated','status','op_status','op_updated_at','op_started_at',
    'items','decisions','title','now_state','now_next','now_note','now_note_version','now_note_updated_at','fed_ts','fed_hlc','origin'];
  IF (old_inputs - generated_columns) IS DISTINCT FROM (new_inputs - generated_columns)
     OR (OLD.status IS DISTINCT FROM NEW.status AND NOT
       (OLD.status IN ('ready','active','awaiting-acceptance') AND NEW.status IN ('ready','active','awaiting-acceptance')))
     OR (NEW.op_status IN ('paused','done') AND OLD.op_status IS DISTINCT FROM NEW.op_status)
     OR (OLD.content IS DISTINCT FROM NEW.content AND preserved IS DISTINCT FROM
       jsonb_build_array(NEW.workspace_id,NEW.harness_slug,NEW.plan_slug,OLD.content_hash,NEW.content_hash))
  THEN
    NEW.execution_start_revision_seq := NULL;
  ELSIF NEW.execution_start_revision_seq IS DISTINCT FROM OLD.execution_start_revision_seq
    AND NEW.execution_start_revision_seq IS NOT NULL
    AND issued IS DISTINCT FROM jsonb_build_array(NEW.workspace_id,NEW.harness_slug,NEW.plan_slug,
      NEW.content_hash,NEW.execution_start_revision_seq)
  THEN
    NEW.execution_start_revision_seq := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fence_plan_execution_start ON harness_shared.harness_plans;
CREATE TRIGGER fence_plan_execution_start BEFORE INSERT OR UPDATE
  ON harness_shared.harness_plans FOR EACH ROW EXECUTE FUNCTION harness_shared.fence_plan_execution_start();

-- Plan lines and dependency edges are canonical inputs. Invalidate the exact
-- parent transactionally, including edit-then-revert; ordinary status progress survives.
CREATE OR REPLACE FUNCTION harness_shared.fence_plan_execution_graph()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior jsonb; current_row jsonb; scope_row jsonb;
  fields text[] := ARRAY['workspace_id','harness_slug','plan_slug','plan_line_id',
    'plan_line_text','plan_importance','plan_phase','plan_decision_refs',
    'plan_deliverable','plan_owner_gate_marker','plan_seq'];
BEGIN
  IF TG_OP <> 'INSERT' THEN prior := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current_row := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'work_items' THEN
    IF TG_OP = 'UPDATE' AND
      (SELECT jsonb_object_agg(key,value) FROM jsonb_each(prior) WHERE key=ANY(fields))
        IS NOT DISTINCT FROM
      (SELECT jsonb_object_agg(key,value) FROM jsonb_each(current_row) WHERE key=ANY(fields))
      AND (prior->>'status' IN ('dropped','superseded')) IS NOT DISTINCT FROM
          (current_row->>'status' IN ('dropped','superseded')) THEN RETURN NULL;
    END IF;
    FOR scope_row IN SELECT value FROM jsonb_array_elements(jsonb_build_array(prior,current_row)) LOOP
      IF scope_row->>'plan_line_id' IS NOT NULL THEN
        UPDATE harness_shared.harness_plans SET execution_start_revision_seq=NULL
          WHERE workspace_id=scope_row->>'workspace_id' AND harness_slug=scope_row->>'harness_slug'
            AND plan_slug=scope_row->>'plan_slug' AND execution_start_revision_seq IS NOT NULL;
      END IF;
    END LOOP;
  ELSE
    FOR scope_row IN SELECT value FROM jsonb_array_elements(jsonb_build_array(prior,current_row)) LOOP
      IF scope_row->>'dep_type' = 'blocks' AND scope_row->>'workspace_id' = 'default' THEN
        UPDATE harness_shared.harness_plans p SET execution_start_revision_seq=NULL
          WHERE p.execution_start_revision_seq IS NOT NULL AND EXISTS (
            SELECT 1 FROM harness_shared.work_items n WHERE n.workspace_id=p.workspace_id
              AND n.harness_slug=p.harness_slug AND n.plan_slug=p.plan_slug AND n.plan_line_id IS NOT NULL
              AND (scope_row->>'blocked_ref' IN (n.feature_id,n.harness_slug || '#' || n.feature_id)
                OR scope_row->>'blocker_ref' IN (n.feature_id,n.harness_slug || '#' || n.feature_id)));
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS fence_plan_execution_graph ON harness_shared.work_items;
CREATE TRIGGER fence_plan_execution_graph AFTER INSERT OR UPDATE OR DELETE
  ON harness_shared.work_items FOR EACH ROW EXECUTE FUNCTION harness_shared.fence_plan_execution_graph();
DROP TRIGGER IF EXISTS fence_plan_execution_graph ON harness_shared.work_item_deps;
CREATE TRIGGER fence_plan_execution_graph AFTER INSERT OR UPDATE OR DELETE
  ON harness_shared.work_item_deps FOR EACH ROW EXECUTE FUNCTION harness_shared.fence_plan_execution_graph();

-- Extend the existing federation clock mask: local authority is not document content.
DO $$
DECLARE definition text; updated_definition text;
BEGIN
  IF to_regprocedure('harness_shared.stamp_local_federated_write()') IS NOT NULL THEN
    SELECT pg_get_functiondef('harness_shared.stamp_local_federated_write()'::regprocedure) INTO definition;
    IF position('execution_start_revision_seq' IN definition)=0 THEN
      updated_definition := regexp_replace(definition, E'\nBEGIN\n',
        E'\nBEGIN\n  IF TG_TABLE_NAME = ''harness_plans'' THEN\n    mask := mask || ARRAY[''execution_start_revision_seq''];\n  END IF;\n');
      IF updated_definition=definition THEN RAISE EXCEPTION 'plan execution clock mask insertion point missing'; END IF;
      EXECUTE updated_definition;
    END IF;
  END IF;
END $$;

