-- EI-28017171914991959: forward-install the tested 992 reopen predicate.
-- Applied migrations are filename-ledgered: editing 992 did not update live DBs.
-- Preserve 1590 cleanup classification and all satisfaction/locking guards.
-- Replace only the function; do not replay 992 global data resync.
CREATE OR REPLACE FUNCTION harness_shared.reject_inconsistent_dependency_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
DECLARE
  v_kind text;
  v_ref text;
  v_old_status text := lower(COALESCE(OLD.status, ''));
  v_new_status text := lower(COALESCE(NEW.status, ''));
  v_conflict record;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF OLD.item_kind = ANY (ARRAY['bug','change','task','cleanup']) THEN
    v_kind := 'issue'; v_ref := OLD.feature_id;
  ELSE
    v_kind := 'feature'; v_ref := OLD.harness_slug || '#' || OLD.feature_id;
  END IF;

  IF v_new_status = ANY (ARRAY['wip','in_progress','validating']) THEN
    SELECT d.blocker_kind, d.blocker_ref, blocker.status AS blocker_status, d.satisfaction
      INTO v_conflict
      FROM harness_shared.work_item_deps d
      JOIN harness_shared.work_items blocker
        ON blocker.workspace_id = NEW.workspace_id
       AND ((d.blocker_kind='issue' AND blocker.item_kind=ANY(ARRAY['bug','change','task','cleanup']) AND d.blocker_ref=blocker.feature_id)
         OR (d.blocker_kind='feature' AND blocker.item_kind<>ALL(ARRAY['bug','change','task','cleanup']) AND d.blocker_ref=blocker.harness_slug||'#'||blocker.feature_id))
     WHERE d.dep_type='blocks' AND d.blocked_kind=v_kind AND d.blocked_ref=v_ref
       AND CASE
         WHEN d.satisfaction='success' AND blocker.item_kind=ANY(ARRAY['bug','change','task','cleanup']) THEN lower(COALESCE(blocker.status,''))<>ALL(ARRAY['resolved','done'])
         WHEN d.satisfaction='success' THEN lower(COALESCE(blocker.status,''))<>ALL(ARRAY['passed','done'])
         WHEN blocker.item_kind=ANY(ARRAY['bug','change','task','cleanup']) THEN lower(COALESCE(blocker.status,''))<>ALL(ARRAY['resolved','closed','done','dropped'])
         ELSE lower(COALESCE(blocker.status,''))<>ALL(ARRAY['passed','deprecated','done','dropped'])
       END
     ORDER BY d.workspace_id,d.blocker_kind,d.blocker_ref LIMIT 1 FOR KEY SHARE OF d,blocker;
    IF FOUND THEN
      RAISE EXCEPTION USING ERRCODE='23514',
        MESSAGE=format('cannot move dependency dependant %s:%s to status %s while %s blocker %s:%s is %s',v_kind,v_ref,NEW.status,v_conflict.satisfaction,v_conflict.blocker_kind,v_conflict.blocker_ref,v_conflict.blocker_status),
        CONSTRAINT='work_items_dependency_dependant_progress_guard',TABLE='work_items',SCHEMA='harness_shared';
    END IF;
  END IF;

  SELECT d.blocked_kind,d.blocked_ref,dependant.status AS dependant_status
    INTO v_conflict
    FROM harness_shared.work_item_deps d
    JOIN harness_shared.work_items dependant
      ON dependant.workspace_id=OLD.workspace_id
     AND ((d.blocked_kind='issue' AND dependant.item_kind=ANY(ARRAY['bug','change','task','cleanup']) AND d.blocked_ref=dependant.feature_id)
       OR (d.blocked_kind='feature' AND dependant.item_kind<>ALL(ARRAY['bug','change','task','cleanup']) AND d.blocked_ref=dependant.harness_slug||'#'||dependant.feature_id))
   WHERE d.dep_type='blocks' AND d.blocker_kind=v_kind AND d.blocker_ref=v_ref
     AND (
       (d.satisfaction='success' AND (
         (NEW.item_kind=ANY(ARRAY['bug','change','task','cleanup']) AND v_new_status=ANY(ARRAY['closed','dropped']))
         OR (NEW.item_kind<>ALL(ARRAY['bug','change','task','cleanup']) AND v_new_status=ANY(ARRAY['deprecated','dropped']))
       ))
       OR (
         CASE WHEN d.satisfaction='success'
              THEN CASE WHEN OLD.item_kind=ANY(ARRAY['bug','change','task','cleanup']) THEN v_old_status=ANY(ARRAY['resolved','done']) ELSE v_old_status=ANY(ARRAY['passed','done']) END
              ELSE CASE WHEN OLD.item_kind=ANY(ARRAY['bug','change','task','cleanup']) THEN v_old_status=ANY(ARRAY['resolved','closed','done','dropped']) ELSE v_old_status=ANY(ARRAY['passed','deprecated','done','dropped']) END END
         AND NOT CASE WHEN d.satisfaction='success'
              THEN CASE WHEN NEW.item_kind=ANY(ARRAY['bug','change','task','cleanup']) THEN v_new_status=ANY(ARRAY['resolved','done']) ELSE v_new_status=ANY(ARRAY['passed','done']) END
              ELSE CASE WHEN NEW.item_kind=ANY(ARRAY['bug','change','task','cleanup']) THEN v_new_status=ANY(ARRAY['resolved','closed','done','dropped']) ELSE v_new_status=ANY(ARRAY['passed','deprecated','done','dropped']) END END
       )
     )
     AND (
       (
         NULLIF(btrim(dependant.taken_by), '') IS NOT NULL
         AND lower(btrim(dependant.taken_by)) <> 'unassigned'
       )
       OR lower(COALESCE(dependant.status, '')) = ANY (ARRAY['wip', 'in_progress', 'validating'])
       OR dependant.last_progress_at IS NOT NULL
       OR (
         dependant.item_kind = ANY (ARRAY['bug', 'change', 'task', 'cleanup'])
         AND lower(COALESCE(dependant.status, '')) = ANY (ARRAY['resolved', 'closed', 'done', 'dropped'])
       )
       OR (
         dependant.item_kind <> ALL (ARRAY['bug', 'change', 'task', 'cleanup'])
         AND lower(COALESCE(dependant.status, '')) = ANY (ARRAY['passed', 'deprecated', 'done', 'dropped'])
       )
     )
   ORDER BY d.workspace_id,d.blocked_kind,d.blocked_ref LIMIT 1 FOR KEY SHARE OF d,dependant;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE='23514',
      MESSAGE=format('cannot make dependency blocker %s:%s unsatisfied while nonterminal dependant %s:%s remains',v_kind,v_ref,v_conflict.blocked_kind,v_conflict.blocked_ref),
      CONSTRAINT='work_items_dependency_blocker_outcome_guard',TABLE='work_items',SCHEMA='harness_shared';
  END IF;
  RETURN NEW;
END;
$guard$;
