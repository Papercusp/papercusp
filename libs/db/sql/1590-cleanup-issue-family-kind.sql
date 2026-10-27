-- 1590-cleanup-issue-family-kind.sql
--
-- code-cleanup-campaigns-2026-10-26 P-003 (R-3, D-003): item kind 'cleanup' joins the
-- issue family. The TypeScript side has ONE list (ISSUE_FAMILY_ROUTE_KINDS in
-- packages/operator-core/lib/work-nature/agent-work-predicate.ts); the database spells the
-- same list as a literal in trigger functions, views and partial-index predicates. This
-- migration DERIVES the change for functions and views: every harness_shared function or
-- view whose source carries the literal issue-family triple ('bug','change','task') gets
-- 'cleanup' appended, in the spelling that object already uses. Every occurrence is
-- extended, including NOT IN / <> ALL forms, because those mean "feature family" and
-- cleanup is no longer feature family. Idempotent: an occurrence already followed by
-- 'cleanup' is not matched.
--
-- LOCKING (revised after the first version deadlocked, 40P01, in the :3170 staging-sync
-- preflight on 2026-10-27): the first version also rebuilt partial indexes in this
-- transaction, so it held SHARE on work_items and then asked for ACCESS EXCLUSIVE on the
-- views — a lock upgrade against readers that hold a view lock and wait on work_items.
-- This file now takes NO lock on work_items: CREATE OR REPLACE FUNCTION takes no relation
-- lock, and each view is replaced dependents-first, so a reader that locks a dependent
-- view before its base view never holds what this transaction waits on. The index
-- widening moved to 1591, which takes its one lock up front.

SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION pg_temp.cleanup1590_extend(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT regexp_replace(
           regexp_replace(
             regexp_replace(s,
               '(''bug''::text, ''change''::text, ''task''::text)(?!, ''cleanup'')',
               '\1, ''cleanup''::text', 'g'),
             '(''bug'', ''change'', ''task'')(?!, ''cleanup'')',
             '\1, ''cleanup''', 'g'),
           '(''bug'',''change'',''task'')(?!,''cleanup'')',
           '\1,''cleanup''', 'g')
$fn$;

DO $$
DECLARE
  r record;
  v_new text;
  v_fns int := 0;
  v_views int := 0;
  v_left int;
BEGIN
  -- 1. Functions (trigger functions keep their triggers under CREATE OR REPLACE).
  FOR r IN
    SELECT p.oid, p.proname
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'harness_shared'
       AND p.prokind = 'f'
       AND p.prosrc <> pg_temp.cleanup1590_extend(p.prosrc)
     ORDER BY p.proname
  LOOP
    v_new := pg_temp.cleanup1590_extend(pg_get_functiondef(r.oid));
    EXECUTE v_new;
    v_fns := v_fns + 1;
  END LOOP;

  -- 2. Views, dependents first (a view that reads other views is replaced before them).
  FOR r IN
    SELECT c.oid, c.relname,
           (SELECT count(DISTINCT d.refobjid)
              FROM pg_rewrite rw
              JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = rw.oid
              JOIN pg_class rc ON rc.oid = d.refobjid AND rc.relkind = 'v'
             WHERE rw.ev_class = c.oid AND d.refobjid <> c.oid) AS view_deps
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'harness_shared'
       AND c.relkind = 'v'
       AND pg_get_viewdef(c.oid) <> pg_temp.cleanup1590_extend(pg_get_viewdef(c.oid))
     ORDER BY view_deps DESC, c.relname
  LOOP
    v_new := rtrim(btrim(pg_temp.cleanup1590_extend(pg_get_viewdef(r.oid))), ';');
    EXECUTE format('CREATE OR REPLACE VIEW harness_shared.%I AS %s', r.relname, v_new);
    v_views := v_views + 1;
  END LOOP;

  -- 3. Post-conditions.
  SELECT count(*) INTO v_left
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'harness_shared' AND p.prokind = 'f'
     AND p.prosrc <> pg_temp.cleanup1590_extend(p.prosrc);
  IF v_left > 0 THEN
    RAISE EXCEPTION '1590: % harness_shared function(s) still carry the three-kind issue-family list', v_left;
  END IF;

  SELECT count(*) INTO v_left
    FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
   WHERE ns.nspname = 'harness_shared' AND c.relkind = 'v'
     AND pg_get_viewdef(c.oid) <> pg_temp.cleanup1590_extend(pg_get_viewdef(c.oid));
  IF v_left > 0 THEN
    RAISE EXCEPTION '1590: % harness_shared view(s) still carry the three-kind issue-family list', v_left;
  END IF;

  RAISE NOTICE '1590: cleanup joined the issue family in % function(s), % view(s)', v_fns, v_views;
END
$$;
