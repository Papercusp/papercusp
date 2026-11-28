-- P-007. The plan-wide start remains NULL after any graph amendment. Retain the
-- original local receipt for canonical held lanes only on typed edge additions.
-- Existing invalidations lack this evidence and cannot acquire it retroactively.
CREATE OR REPLACE FUNCTION harness_shared.fence_plan_execution_start()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE preserved jsonb; issued jsonb; old_inputs jsonb; new_inputs jsonb;
  generated_columns text[]; reason text; added_edge jsonb; prior_edges jsonb; prior_seq integer;
  progress_fields text[] := ARRAY['execution_start_revision_seq','execution_start_invalidation',
    'content','content_hash','version','updated_at','updated','status','op_status','op_updated_at','op_started_at',
    'items','decisions','title','now_state','now_next','now_note','now_note_version','now_note_updated_at',
    'fed_ts','fed_hlc','origin'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.execution_start_revision_seq := NULL;
    NEW.execution_start_invalidation := NULL;
    RETURN NEW;
  END IF;
  preserved := COALESCE(NULLIF(current_setting('papercusp.execution_progress', true), ''), 'null')::jsonb;
  issued := COALESCE(NULLIF(current_setting('papercusp.execution_start', true), ''), 'null')::jsonb;
  SELECT COALESCE(array_agg(attname::text), ARRAY[]::text[]) INTO generated_columns
    FROM pg_attribute WHERE attrelid=TG_RELID AND attgenerated<>'' AND NOT attisdropped;
  old_inputs := to_jsonb(OLD) - progress_fields - generated_columns;
  new_inputs := to_jsonb(NEW) - progress_fields - generated_columns;
  prior_edges := OLD.execution_start_invalidation->'dependencyAdditions';
  IF jsonb_typeof(prior_edges) = 'array' THEN
    prior_seq := (OLD.execution_start_invalidation->>'startRevisionSeq')::integer;
  ELSE prior_edges := NULL;
  END IF;
  IF old_inputs IS DISTINCT FROM new_inputs THEN reason := 'structured_inputs_changed';
  ELSIF OLD.status IS DISTINCT FROM NEW.status AND NOT
    (OLD.status IN ('ready','active','awaiting-acceptance') AND NEW.status IN ('ready','active','awaiting-acceptance'))
    THEN reason := 'lifecycle_status_changed';
  ELSIF NEW.op_status IN ('paused','done') AND OLD.op_status IS DISTINCT FROM NEW.op_status
    THEN reason := 'operational_pause_or_finish';
  ELSIF OLD.content IS DISTINCT FROM NEW.content AND preserved IS DISTINCT FROM
    jsonb_build_array(NEW.workspace_id,NEW.harness_slug,NEW.plan_slug,OLD.content_hash,NEW.content_hash)
    THEN reason := 'plan_body_changed';
  ELSIF NEW.execution_start_revision_seq IS DISTINCT FROM OLD.execution_start_revision_seq
    AND NEW.execution_start_revision_seq IS NOT NULL AND issued IS DISTINCT FROM
    jsonb_build_array(NEW.workspace_id,NEW.harness_slug,NEW.plan_slug,NEW.content_hash,NEW.execution_start_revision_seq)
    THEN reason := 'unissued_start_reference';
  ELSIF NEW.execution_start_revision_seq IS NULL AND
    (OLD.execution_start_revision_seq IS NOT NULL OR (prior_edges IS NOT NULL AND
      pg_trigger_depth() > 1 AND NULLIF(current_setting('papercusp.execution_invalidation_reason', true), '') IS NOT NULL))
    THEN reason := COALESCE(NULLIF(current_setting('papercusp.execution_invalidation_reason', true), ''), 'explicit_start_clear');
  END IF;
  IF reason IS NOT NULL THEN
    NEW.execution_start_revision_seq := NULL;
    prior_seq := COALESCE(OLD.execution_start_revision_seq, prior_seq);
    IF prior_seq IS NOT NULL THEN
      NEW.execution_start_invalidation := jsonb_build_object(
        'schema','plan-execution-invalidation-v1',
        'scope',jsonb_build_object('workspaceId',OLD.workspace_id,'harnessSlug',OLD.harness_slug,'planSlug',OLD.plan_slug),
        'startRevisionSeq',prior_seq,'reason',reason,
        'changedFields',(SELECT COALESCE(jsonb_agg(key ORDER BY key),'[]'::jsonb)
          FROM jsonb_object_keys(old_inputs || new_inputs) key
          WHERE old_inputs->key IS DISTINCT FROM new_inputs->key),
        'at',clock_timestamp(),'transaction',txid_current());
      IF reason = 'dependency_changed' AND pg_trigger_depth() > 1 THEN
        added_edge := NULLIF(current_setting('papercusp.execution_dependency_addition', true), '')::jsonb;
        IF added_edge IS NOT NULL THEN
          NEW.execution_start_invalidation := NEW.execution_start_invalidation || jsonb_build_object(
            'dependencyAdditions', COALESCE(prior_edges, '[]'::jsonb) || jsonb_build_array(added_edge),
            'scopedSince', COALESCE(OLD.execution_start_invalidation->'scopedSince', NEW.execution_start_invalidation->'at'));
        END IF;
      END IF;
    ELSE NEW.execution_start_invalidation := OLD.execution_start_invalidation;
    END IF;
  ELSIF NEW.execution_start_revision_seq IS NOT NULL THEN
    NEW.execution_start_invalidation := NULL;
  ELSE NEW.execution_start_invalidation := OLD.execution_start_invalidation;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION harness_shared.fence_plan_execution_graph()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior jsonb; current_row jsonb; scope_row jsonb; previous_reason text; previous_addition text; added_edge jsonb;
  fields text[] := ARRAY['workspace_id','harness_slug','plan_slug','plan_line_id',
    'plan_line_text','plan_importance','plan_phase','plan_decision_refs',
    'plan_deliverable','plan_owner_gate_marker','plan_seq'];
  dependency_fields text[] := ARRAY['workspace_id','dep_type','blocked_kind','blocked_ref','blocker_kind','blocker_ref','satisfaction'];
BEGIN
  IF TG_OP <> 'INSERT' THEN prior := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current_row := to_jsonb(NEW); END IF;
  IF TG_TABLE_NAME = 'work_items' THEN
    IF TG_OP = 'UPDATE' AND
      (SELECT jsonb_object_agg(key,value) FROM jsonb_each(prior) WHERE key=ANY(fields)) IS NOT DISTINCT FROM
      (SELECT jsonb_object_agg(key,value) FROM jsonb_each(current_row) WHERE key=ANY(fields))
      AND (prior->>'status' IN ('dropped','superseded')) IS NOT DISTINCT FROM
          (current_row->>'status' IN ('dropped','superseded')) THEN RETURN NULL;
    END IF;
    previous_reason := current_setting('papercusp.execution_invalidation_reason', true);
    PERFORM set_config('papercusp.execution_invalidation_reason','plan_line_changed',true);
    FOR scope_row IN SELECT value FROM jsonb_array_elements(jsonb_build_array(prior,current_row)) LOOP
      IF scope_row->>'plan_line_id' IS NOT NULL THEN
        UPDATE harness_shared.harness_plans SET execution_start_revision_seq=NULL
          WHERE workspace_id=scope_row->>'workspace_id' AND harness_slug=scope_row->>'harness_slug'
            AND plan_slug=scope_row->>'plan_slug' AND (execution_start_revision_seq IS NOT NULL
              OR execution_start_invalidation ? 'dependencyAdditions');
      END IF;
    END LOOP;
  ELSE
    -- Federation and dependency bookkeeping can replay an identical edge.
    -- Only endpoint, dependency type or satisfaction changes revoke a start.
    IF TG_OP = 'UPDATE' AND
      (SELECT jsonb_object_agg(key,value) FROM jsonb_each(prior) WHERE key=ANY(dependency_fields)) IS NOT DISTINCT FROM
      (SELECT jsonb_object_agg(key,value) FROM jsonb_each(current_row) WHERE key=ANY(dependency_fields)) THEN RETURN NULL;
    END IF;
    previous_reason := current_setting('papercusp.execution_invalidation_reason', true);
    previous_addition := current_setting('papercusp.execution_dependency_addition', true);
    -- Scope only actual, typed insertions. Replacements and removals revoke the scoped proof.
    IF TG_OP = 'INSERT' AND current_row->>'blocked_kind' IN ('feature','issue')
      AND current_row->>'blocker_kind' IN ('feature','issue')
      AND NULLIF(current_row->>'blocked_ref','') IS NOT NULL AND NULLIF(current_row->>'blocker_ref','') IS NOT NULL
      AND current_row->>'satisfaction' IN ('settled','success') THEN
      SELECT jsonb_object_agg(key,value) INTO added_edge FROM jsonb_each(current_row)
        WHERE key IN ('blocked_kind','blocked_ref','blocker_kind','blocker_ref','satisfaction');
    END IF;
    PERFORM set_config('papercusp.execution_dependency_addition',COALESCE(added_edge::text,''),true);
    PERFORM set_config('papercusp.execution_invalidation_reason','dependency_changed',true);
    FOR scope_row IN SELECT value FROM jsonb_array_elements(jsonb_build_array(prior,current_row)) LOOP
      IF scope_row->>'dep_type' = 'blocks' AND scope_row->>'workspace_id' = 'default' THEN
        UPDATE harness_shared.harness_plans p SET execution_start_revision_seq=NULL
          WHERE (p.execution_start_revision_seq IS NOT NULL OR p.execution_start_invalidation ? 'dependencyAdditions')
            AND EXISTS (
            SELECT 1 FROM harness_shared.work_items n WHERE n.workspace_id=p.workspace_id
              AND n.harness_slug=p.harness_slug AND n.plan_slug=p.plan_slug AND n.plan_line_id IS NOT NULL
              AND ((scope_row->>'blocked_kind'='feature' AND n.item_kind='feature' AND scope_row->>'blocked_ref'=n.harness_slug || '#' || n.feature_id)
                OR (scope_row->>'blocker_kind'='feature' AND n.item_kind='feature' AND scope_row->>'blocker_ref'=n.harness_slug || '#' || n.feature_id)
                OR (scope_row->>'blocked_kind'='issue' AND scope_row->>'blocked_ref'=n.feature_id
                  AND n.item_kind IN ('bug','change','task','cleanup'))
                OR (scope_row->>'blocker_kind'='issue' AND scope_row->>'blocker_ref'=n.feature_id
                  AND n.item_kind IN ('bug','change','task','cleanup'))));
      END IF;
    END LOOP;
    PERFORM set_config('papercusp.execution_dependency_addition',COALESCE(previous_addition,''),true);
  END IF;
  PERFORM set_config('papercusp.execution_invalidation_reason',COALESCE(previous_reason,''),true);
  RETURN NULL;
END $$;

-- UPDATE OF distinguishes an explicit stop from ordinary progress when the
-- plan-wide pointer is already NULL. Run after fence_plan_execution_start.
CREATE OR REPLACE FUNCTION harness_shared.clear_scoped_plan_execution_start()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_start_revision_seq IS NULL AND OLD.execution_start_revision_seq IS NULL
    AND NEW.execution_start_invalidation ? 'dependencyAdditions'
    AND NOT (pg_trigger_depth() > 1 AND
      COALESCE(current_setting('papercusp.execution_invalidation_reason',true),'') = 'dependency_changed') THEN
    NEW.execution_start_invalidation := (NEW.execution_start_invalidation - 'dependencyAdditions' - 'scopedSince')
      || jsonb_build_object('reason','explicit_start_clear','at',clock_timestamp(),'transaction',txid_current());
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS revoke_explicit_scoped_start ON harness_shared.harness_plans;
CREATE TRIGGER revoke_explicit_scoped_start BEFORE UPDATE OF execution_start_revision_seq
  ON harness_shared.harness_plans FOR EACH ROW EXECUTE FUNCTION harness_shared.clear_scoped_plan_execution_start();
