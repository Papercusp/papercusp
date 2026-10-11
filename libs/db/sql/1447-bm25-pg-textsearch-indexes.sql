-- 1447 — Real BM25 ranking: the pg_textsearch extension and one BM25 index per lexical corpus.
-- Plan bm25-lexical-search-evoke-adoption-2026-10-10 P-003 (engine: D-002; architecture: D-003).
--
-- AVAILABILITY GATE. pg_textsearch works only when it is in shared_preload_libraries, and a
-- library listed there but absent on disk stops the postmaster, so preload is conditional
-- (embedded-postgres-server preloads it only when the binary tree ships it; the dev box and
-- staging preload it through scripts/pg-autotune.ts). This migration therefore creates
-- nothing unconditionally: it defines the functions below and calls bm25_ensure_indexes()
-- once. That function installs the extension and builds indexes only when the library is
-- preloaded and available; otherwise it raises a NOTICE and returns. Such hosts keep the
-- legacy ts_rank_cd path, which the BM25 health check (P-004) reports as degraded. The
-- maintenance workflow (P-006) calls bm25_ensure_indexes() on every run, so a host whose
-- library appears later converges without another migration.
--
-- PRIVILEGE. pg_textsearch is not a trusted extension, so CREATE EXTENSION needs a
-- superuser. A non-superuser caller gets outcome 'skipped:insufficient-privilege'.
--
-- LARGE TABLES. A plain CREATE INDEX blocks writes for the whole build, so a table whose
-- estimated row count exceeds p_large_table_rows is reported 'deferred:build-concurrently'
-- instead. The maintenance workflow builds it with bm25_index_ddl(name, true), which is
-- CREATE INDEX CONCURRENTLY and cannot run inside a function or a transaction.
--
-- ONE INDEX PER CORPUS. When two bm25 indexes cover the same expression the planner may use
-- either, and a query that names its index in to_bm25query() then errors ("query specifies
-- index X but planner chose index Y"). bm25_ensure_indexes() reports every other bm25 index
-- on a corpus table as 'duplicate:<name>'.
--
-- The rows of bm25_corpus_indexes() are the DDL source of truth and must stay byte-identical
-- to packages/operator-core/lib/search/lexical/corpora.ts (pinned by corpora.test.ts).
-- Corpora that call sites rank over inline to_tsvector(...) expressions (knowledge sources,
-- conventions, package doc parts) are added when the P-005 seam covers them.
--
-- Additive only: new functions, and indexes/extension created only when available.

CREATE OR REPLACE FUNCTION harness_shared.bm25_corpus_indexes()
RETURNS TABLE (index_name text, table_name text, text_expr text, text_config text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  VALUES
    ('work_items_bm25', 'work_items', $e$coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(notes, '')$e$, 'english'),
    ('harness_plans_bm25', 'harness_plans', $e$coalesce(title, '') || ' ' || coalesce(content, '')$e$, 'english'),
    ('goals_bm25', 'goals', $e$coalesce(title, '') || ' ' || coalesce(body, '')$e$, 'english'),
    ('report_library_bm25', 'report_library', $e$coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(subject_label, '') || ' ' || left(coalesce(body_md, ''), 200000)$e$, 'english'),
    ('session_turns_bm25', 'session_turns', $e$left(coalesce(text, ''), 20000)$e$, 'english'),
    ('documents_bm25', 'documents', $e$coalesce(title, '') || ' ' || coalesce(text, '')$e$, 'english'),
    ('coord_thread_posts_bm25', 'coord_thread_posts', $e$coalesce(body, '')$e$, 'english'),
    ('carry_notes_bm25', 'carry_notes', $e$coalesce(note, '')$e$, 'english'),
    ('code_recipes_bm25', 'code_recipes', $e$coalesce(title, '') || ' ' || coalesce(description, '')$e$, 'english'),
    ('datatype_registry_bm25', 'datatype_registry', $e$coalesce(title, '') || ' ' || coalesce(description, '')$e$, 'english'),
    ('event_key_registry_bm25', 'event_key_registry', $e$coalesce(title, '') || ' ' || coalesce(description, '')$e$, 'english'),
    ('capability_class_registry_bm25', 'capability_class_registry', $e$coalesce(title, '') || ' ' || coalesce(description, '')$e$, 'english'),
    ('audit_log_bm25', 'audit_log', $e$coalesce(subject, '') || ' ' || coalesce(action, '') || ' ' || coalesce(actor, '')$e$, 'simple'),
    ('harness_escalations_bm25', 'harness_escalations', $e$coalesce(escalation, '') || ' ' || coalesce(supervisor_notes, '')$e$, 'english'),
    ('harness_decisions_bm25', 'harness_decisions', $e$coalesce(verb, '') || ' ' || coalesce(args, '')$e$, 'english'),
    ('harness_brainstorm_bm25', 'harness_brainstorm', $e$coalesce(content, '')$e$, 'english')
$fn$;

COMMENT ON FUNCTION harness_shared.bm25_corpus_indexes() IS
  'BM25 (pg_textsearch) corpora: index name, table, indexed text expression, text config. '
  'Must match packages/operator-core/lib/search/lexical/corpora.ts. Plan bm25-lexical-search-evoke-adoption-2026-10-10 D-003.';

-- True when the pg_textsearch library is loaded in this backend, which with a preload-only
-- library means it is in shared_preload_libraries. The signal is the library's own internal
-- GUC pg_textsearch.library_version, defined only once the library is loaded and readable
-- by every role. shared_preload_libraries itself is not: a role without pg_read_all_settings
-- gets "permission denied to examine" (measured on PG 18.6), which would abort the function.
CREATE OR REPLACE FUNCTION harness_shared.bm25_library_preloaded()
RETURNS boolean
LANGUAGE sql STABLE
AS $fn$
  SELECT current_setting('pg_textsearch.library_version', true) IS NOT NULL
$fn$;

-- The CREATE INDEX statement for one corpus; p_concurrently=true for large live tables.
CREATE OR REPLACE FUNCTION harness_shared.bm25_index_ddl(p_index_name text, p_concurrently boolean DEFAULT false)
RETURNS text
LANGUAGE sql STABLE
AS $fn$
  SELECT format(
           'CREATE INDEX %s IF NOT EXISTS %I ON harness_shared.%I USING bm25 ((%s)) WITH (text_config = %L, compaction = %L)',
           CASE WHEN p_concurrently THEN 'CONCURRENTLY' ELSE '' END,
           c.index_name, c.table_name, c.text_expr, c.text_config, 'manual')
    FROM harness_shared.bm25_corpus_indexes() AS c
   WHERE c.index_name = p_index_name
$fn$;

-- Installs the extension and builds missing small-table indexes when the engine is
-- available. One row per corpus (or one row with a NULL corpus_index when skipped). Outcomes:
--   skipped:library-not-preloaded | skipped:extension-unavailable | skipped:insufficient-privilege
--   skipped:table-missing | present | invalid | conflict:not-bm25 | created
--   deferred:build-concurrently | duplicate:<other index name>
CREATE OR REPLACE FUNCTION harness_shared.bm25_ensure_indexes(p_large_table_rows bigint DEFAULT 200000)
RETURNS TABLE (corpus_index text, outcome text)
LANGUAGE plpgsql
AS $fn$
DECLARE
  c record;
  v_table regclass;
  v_rows double precision;
  v_valid boolean;
  v_am text;
  v_dup text;
BEGIN
  IF NOT harness_shared.bm25_library_preloaded() THEN
    RAISE NOTICE 'bm25_ensure_indexes: pg_textsearch is not in shared_preload_libraries; lexical search stays on ts_rank_cd';
    corpus_index := NULL; outcome := 'skipped:library-not-preloaded'; RETURN NEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_textsearch') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_textsearch') THEN
      RAISE NOTICE 'bm25_ensure_indexes: pg_textsearch is preloaded but its extension files are not installed';
      corpus_index := NULL; outcome := 'skipped:extension-unavailable'; RETURN NEXT;
      RETURN;
    END IF;
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pg_textsearch WITH SCHEMA public;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'bm25_ensure_indexes: role % may not CREATE EXTENSION pg_textsearch (not a trusted extension)', current_user;
      corpus_index := NULL; outcome := 'skipped:insufficient-privilege'; RETURN NEXT;
      RETURN;
    END;
  END IF;

  FOR c IN SELECT * FROM harness_shared.bm25_corpus_indexes() LOOP
    corpus_index := c.index_name;
    v_table := to_regclass(format('harness_shared.%I', c.table_name));
    IF v_table IS NULL THEN
      outcome := 'skipped:table-missing'; RETURN NEXT;
      CONTINUE;
    END IF;

    FOR v_dup IN
      SELECT i.relname::text
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_am am ON am.oid = i.relam
       WHERE x.indrelid = v_table AND am.amname = 'bm25' AND i.relname <> c.index_name
    LOOP
      outcome := 'duplicate:' || v_dup; RETURN NEXT;
    END LOOP;

    SELECT x.indisvalid, am.amname INTO v_valid, v_am
      FROM pg_class i
      JOIN pg_namespace n ON n.oid = i.relnamespace
      JOIN pg_index x ON x.indexrelid = i.oid
      JOIN pg_am am ON am.oid = i.relam
     WHERE n.nspname = 'harness_shared' AND i.relname = c.index_name;
    IF FOUND THEN
      outcome := CASE WHEN v_am <> 'bm25' THEN 'conflict:not-bm25' WHEN v_valid THEN 'present' ELSE 'invalid' END;
      RETURN NEXT;
      CONTINUE;
    END IF;

    SELECT reltuples INTO v_rows FROM pg_class WHERE oid = v_table;
    IF v_rows > p_large_table_rows THEN
      outcome := 'deferred:build-concurrently'; RETURN NEXT;
      CONTINUE;
    END IF;

    EXECUTE harness_shared.bm25_index_ddl(c.index_name, false);
    outcome := 'created'; RETURN NEXT;
  END LOOP;
END;
$fn$;

COMMENT ON FUNCTION harness_shared.bm25_ensure_indexes(bigint) IS
  'Availability-gated: installs pg_textsearch and builds missing BM25 corpus indexes when the library is preloaded; '
  'tables above p_large_table_rows are deferred to a CONCURRENTLY build. Called by migration 1447 and the BM25 maintenance workflow.';

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM harness_shared.bm25_ensure_indexes() LOOP
    RAISE NOTICE 'bm25_ensure_indexes: % -> %', coalesce(r.corpus_index, '(engine)'), r.outcome;
  END LOOP;
END
$$;
