-- 1591-cleanup-issue-family-index-build.sql
--
-- code-cleanup-campaigns-2026-10-26 P-003 (R-3): widen the positive issue-family partial
-- index predicates (`item_kind = ANY (ARRAY['bug','change','task'])`) to include 'cleanup',
-- so issue-family queries spelled from ISSUE_FAMILY_ROUTE_KINDS (now four kinds) can still
-- use them. The negated feature-family `<> ALL` predicates are LEFT AS IS: a query that
-- excludes four kinds implies the stored predicate that excludes three.
--
-- LOCKING: split out of 1590 after that file deadlocked (40P01) by holding SHARE on
-- work_items and then requesting a stronger lock. This file takes the ONE lock it needs,
-- ACCESS EXCLUSIVE on work_items, as its first statement and never requests another lock
-- on an existing relation, so it cannot be part of a lock cycle; it waits (bounded by
-- lock_timeout) instead. Work-item reads and writes block for the rebuild window.
--
-- FORWARD-COMPAT: the rebuilt partial indexes keep their names and widen their predicate to a superset of the three-kind list, so the currently-deployed release's queries (which filter on the three kinds) are still implied by the new predicates and keep using them; the partial UNIQUE indexes only gain cleanup rows, of which none exist yet.

SET LOCAL lock_timeout = '30s';

LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION pg_temp.cleanup1591_extend_index(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT regexp_replace(s,
    '(= ANY \(ARRAY\[''bug''::text, ''change''::text, ''task''::text)(?!, ''cleanup'')',
    '\1, ''cleanup''::text', 'g')
$fn$;

DO $$
DECLARE
  r record;
  v_new text;
  v_tmp text;
  v_idx int := 0;
  v_left int;
BEGIN
  FOR r IN
    SELECT i.indexname, i.indexdef
      FROM pg_indexes i
     WHERE i.schemaname = 'harness_shared'
       AND i.tablename = 'work_items'
       AND i.indexdef <> pg_temp.cleanup1591_extend_index(i.indexdef)
     ORDER BY i.indexname
  LOOP
    v_tmp := left(r.indexname, 50) || '_c1591';
    v_new := pg_temp.cleanup1591_extend_index(r.indexdef);
    v_new := replace(v_new, ' INDEX ' || r.indexname || ' ON ', ' INDEX ' || v_tmp || ' ON ');
    IF position(v_tmp IN v_new) = 0 THEN
      RAISE EXCEPTION '1591: could not retarget index definition for % — shape changed: %', r.indexname, r.indexdef;
    END IF;
    EXECUTE format('DROP INDEX IF EXISTS harness_shared.%I', v_tmp);
    EXECUTE v_new;
    EXECUTE format('DROP INDEX harness_shared.%I', r.indexname);
    EXECUTE format('ALTER INDEX harness_shared.%I RENAME TO %I', v_tmp, r.indexname);
    v_idx := v_idx + 1;
  END LOOP;

  SELECT count(*) INTO v_left
    FROM pg_indexes i
   WHERE i.schemaname = 'harness_shared'
     AND i.indexdef <> pg_temp.cleanup1591_extend_index(i.indexdef);
  IF v_left > 0 THEN
    RAISE EXCEPTION '1591: % issue-family partial index predicate(s) still carry the three-kind list', v_left;
  END IF;

  RAISE NOTICE '1591: widened % issue-family partial index(es) to include cleanup', v_idx;
END
$$;
