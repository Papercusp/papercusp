-- 1590-cleanup-issue-family-kind.sql
--
-- code-cleanup-campaigns-2026-10-26 P-003 (R-3, D-003): item kind 'cleanup' joins the
-- issue family. The TypeScript side has ONE list (ISSUE_FAMILY_ROUTE_KINDS in
-- packages/operator-core/lib/work-nature/agent-work-predicate.ts); the database spells the
-- same list as a literal in trigger functions, views and partial-index predicates
-- (measured 2026-10-27: 11 functions, 3 views, 9 indexes). Hand-editing each copy is how
-- they drift, so this migration DERIVES the change: every harness_shared object whose
-- source carries the literal issue-family triple ('bug','change','task') gets 'cleanup'
-- appended, in the spelling that object already uses.
--
-- Rules:
--   * functions + views: every occurrence is extended, including NOT IN / <> ALL forms,
--     because those mean "feature family" and cleanup is no longer feature family.
--   * partial indexes: only the positive `= ANY (ARRAY[...])` (issue-family) predicates are
--     rebuilt. The superset predicate keeps the index usable by code that still filters on
--     the three-kind list. The negated `<> ALL` (feature-family) predicates are LEFT AS IS:
--     a query excluding four kinds implies the stored predicate excluding three, so old and
--     new code can both use them (expand/contract, nothing to contract).
--   * idempotent: an occurrence already followed by 'cleanup' is not matched.
--
-- FORWARD-COMPAT: the rebuilt partial indexes keep their names and widen their predicate to a superset of the three-kind list, so the currently-deployed release's queries (which filter on the three kinds) are still implied by the new predicates and keep using them; the partial UNIQUE indexes only gain cleanup rows, of which none exist yet.

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

CREATE OR REPLACE FUNCTION pg_temp.cleanup1590_extend_index(s text) RETURNS text
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
  v_fns int := 0;
  v_views int := 0;
  v_idx int := 0;
  v_left int;
  v_rebuilt text[] := ARRAY[]::text[];
BEGIN
  -- 1. Partial indexes: build the widened copy under a temporary name first (SHARE lock,
  --    reads continue), swap at the end so the ACCESS EXCLUSIVE window is short.
  FOR r IN
    SELECT i.indexname, i.indexdef
      FROM pg_indexes i
     WHERE i.schemaname = 'harness_shared'
       AND i.indexdef <> pg_temp.cleanup1590_extend_index(i.indexdef)
     ORDER BY i.indexname
  LOOP
    v_tmp := left(r.indexname, 50) || '_c1590';
    v_new := pg_temp.cleanup1590_extend_index(r.indexdef);
    v_new := replace(v_new, ' INDEX ' || r.indexname || ' ON ', ' INDEX ' || v_tmp || ' ON ');
    IF position(v_tmp IN v_new) = 0 THEN
      RAISE EXCEPTION '1590: could not retarget index definition for % — shape changed: %', r.indexname, r.indexdef;
    END IF;
    EXECUTE format('DROP INDEX IF EXISTS harness_shared.%I', v_tmp);
    EXECUTE v_new;
    v_rebuilt := v_rebuilt || r.indexname;
    v_idx := v_idx + 1;
  END LOOP;

  -- 2. Functions (trigger functions keep their triggers under CREATE OR REPLACE).
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

  -- 3. Views (same column list, so CREATE OR REPLACE keeps INSTEAD OF triggers and grants).
  FOR r IN
    SELECT c.oid, c.relname
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'harness_shared'
       AND c.relkind = 'v'
       AND pg_get_viewdef(c.oid) <> pg_temp.cleanup1590_extend(pg_get_viewdef(c.oid))
     ORDER BY c.relname
  LOOP
    v_new := rtrim(btrim(pg_temp.cleanup1590_extend(pg_get_viewdef(r.oid))), ';');
    EXECUTE format('CREATE OR REPLACE VIEW harness_shared.%I AS %s', r.relname, v_new);
    v_views := v_views + 1;
  END LOOP;

  -- 4. Swap the rebuilt indexes in.
  FOR i IN 1 .. coalesce(array_length(v_rebuilt, 1), 0) LOOP
    v_tmp := left(v_rebuilt[i], 50) || '_c1590';
    EXECUTE format('DROP INDEX harness_shared.%I', v_rebuilt[i]);
    EXECUTE format('ALTER INDEX harness_shared.%I RENAME TO %I', v_tmp, v_rebuilt[i]);
  END LOOP;

  -- 5. Post-conditions: no harness_shared function or view still carries the bare triple,
  --    and no positive issue-family index predicate does.
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

  SELECT count(*) INTO v_left
    FROM pg_indexes i
   WHERE i.schemaname = 'harness_shared'
     AND i.indexdef <> pg_temp.cleanup1590_extend_index(i.indexdef);
  IF v_left > 0 THEN
    RAISE EXCEPTION '1590: % issue-family partial index predicate(s) still carry the three-kind list', v_left;
  END IF;

  RAISE NOTICE '1590: cleanup joined the issue family in % function(s), % view(s), % partial index(es)', v_fns, v_views, v_idx;
END
$$;
