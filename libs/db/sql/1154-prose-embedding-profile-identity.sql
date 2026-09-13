-- 1154: exact, versioned embedding-space identity for every shared prose vector.
--
-- `*_mode` is retained as a compatibility/readability projection, but it is no
-- longer sufficient to establish that two vectors are comparable: a model,
-- revision, normalization, metric, or input-recipe change can preserve both
-- mode and width while minting a different space. New writers stamp
-- `*_profile`; readers select that exact identity. During rolling upgrade a
-- NULL profile may be interpreted from `*_mode` only when it names that mode's
-- declared CURRENT profile (versioned-embedding-profiles-2026-09-12 D-002).
--
-- EXPAND-ONLY / OLD-BINARY SAFE. No vector is deleted or recomputed here, and
-- existing profile identity deliberately stays NULL. Runtime compatibility
-- maps a NULL profile from `*_mode` only to that mode's declared CURRENT
-- profile, so rewriting the live corpus here would add no information while
-- holding ACCESS EXCLUSIVE for the duration of a potentially multi-million-row
-- UPDATE. New writers stamp exact identity; the resumable backfill re-embeds
-- only rows whose identity cannot be mapped safely. The prior release ignores
-- the added columns and keeps serving.

-- Readers acquire nested compatibility views from the outside in, then the
-- work_items base table. Take the same order before ALTER TABLE can lock the
-- base relation; otherwise the later CREATE OR REPLACE VIEW statements invert
-- that order and can deadlock against a live reader (the migration-721 class).
LOCK TABLE harness_shared.harness_features IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.harness_features_consolidated IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.work_items_claimable IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.engineer_issues IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE;

-- lint-migrations: dynamic-view-lock-order all four compatibility views are locked outside-in before work_items and before the dynamic ALTER loop

DO $migration$
DECLARE
  target record;
  qualified text;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('harness_shared', 'session_turns',      'text_embedding',    'text_embedding_mode'),
      ('harness_shared', 'session_turn_chunks','embedding',         'embedding_mode'),
      ('harness_shared', 'operator_turns',     'text_embedding',    'text_embedding_mode'),
      ('harness_shared', 'work_items',         'embedding',         'embedding_mode'),
      ('harness_shared', 'doc_sections',       'embedding',         'embedding_mode'),
      ('harness_shared', 'harness_docs',       'embedding',         'embedding_mode'),
      ('harness_shared', 'harness_plans',      'embedding',         'embedding_mode'),
      ('harness_shared', 'harness_escalations','body_embedding',    'body_embedding_mode'),
      ('harness_shared', 'harness_brainstorm', 'content_embedding', 'content_embedding_mode'),
      ('harness_shared', 'harness_decisions',  'body_embedding',    'body_embedding_mode'),
      ('harness_shared', 'code_recipes',       'embedding',         'embedding_mode'),
      ('harness_shared', 'datatype_registry',  'embedding',         'embedding_mode'),
      ('harness_shared', 'personal_documents', 'embedding',         'embedding_mode'),
      ('harness_shared', 'consult_state',      'query_embedding',   'query_embedding_mode'),
      ('harness_shared', 'interest_watches',   'embedding',         'embedding_mode'),
      ('harness_shared', 'carry_notes',        'note_embedding',    'note_embedding_mode'),
      ('harness_shared', 'coord_thread_posts', 'body_embedding',    'body_embedding_mode')
    ) AS t(schema_name, table_name, embedding_col, mode_col)
  LOOP
    qualified := format('%I.%I', target.schema_name, target.table_name);
    IF to_regclass(qualified) IS NULL THEN
      CONTINUE;
    END IF;

    -- Two older refill-only surfaces never had the mode discriminator. Add it
    -- now so every future write carries both the human-readable projection and
    -- the exact profile; their existing vectors remain identity-unknown.
    EXECUTE format(
      'ALTER TABLE %s ADD COLUMN IF NOT EXISTS %I text',
      qualified,
      target.mode_col
    );
    EXECUTE format(
      'ALTER TABLE %s ADD COLUMN IF NOT EXISTS %I text',
      qualified,
      target.embedding_col || '_profile'
    );

  END LOOP;
END
$migration$;

-- Append work_items.embedding_profile to the canonical compatibility views
-- without restating their large, independently evolving column lists. The
-- current definition comes from PostgreSQL itself; CREATE OR REPLACE preserves
-- every existing column and appends exactly one new one, which is allowed while
-- dependent views remain live. A failed rewrite aborts the migration loudly.
DO $views$
DECLARE
  view_name text;
  definition text;
  rewritten text;
BEGIN
  FOREACH view_name IN ARRAY ARRAY[
    'harness_shared.harness_features_consolidated',
    'harness_shared.harness_features',
    'harness_shared.work_items_claimable',
    'harness_shared.engineer_issues'
  ]
  LOOP
    IF to_regclass(view_name) IS NULL THEN
      CONTINUE;
    END IF;
    SELECT pg_get_viewdef(view_name::regclass, true) INTO definition;
    IF definition ~ '\membedding_profile\M' THEN
      CONTINUE;
    END IF;

    -- Every canonical definition has a single outer ` FROM `; append the base
    -- column immediately before it. For harness_features (which reads the
    -- consolidated view), that source already gained the appended column in
    -- the preceding iteration.
    rewritten := regexp_replace(
      definition,
      E'\\s+FROM\\s+',
      E', embedding_profile\n  FROM ',
      'i'
    );
    IF rewritten = definition THEN
      RAISE EXCEPTION '1154 could not append embedding_profile to %', view_name;
    END IF;
    EXECUTE format('CREATE OR REPLACE VIEW %s AS %s', view_name, rewritten);
  END LOOP;
END
$views$;

COMMENT ON COLUMN harness_shared.work_items.embedding_profile IS
  'Exact versioned identity of the embedding space stored in embedding. NULL is legacy and may map from embedding_mode only to that mode''s declared current profile.';
