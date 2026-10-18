-- 1534: typed duplicate-of verdict on work items
-- (bug-inflow-one-problem-one-row-2026-10-18#D-001, WI-6554700010017181).
--
-- Owner directive #1990: a duplicate is a FIELD the duplicate (admission) gate
-- checks, not a comment. Until now a duplicate verdict lived only in
-- coord_links (rel 'duplicates') and payload.dedupCandidates, neither of which
-- the claimable predicate reads. These two columns are the single authoritative
-- verdict; the existing evidence surfaces stay where they are.
--
--   duplicate_of      feature_id of the canonical row in the same workspace.
--   duplicate_source  which writer set it: create-exact | admission-promoter
--                     | fold | agent.
--
-- Additive only (expand). NULL on every existing row = "not a duplicate", so
-- the currently deployed release is unaffected.
--
-- LOCK ORDER. This migration takes ACCESS EXCLUSIVE on work_items (ALTER) and
-- then on three views that read it (CREATE OR REPLACE VIEW below). Readers lock
-- a view BEFORE its base table, so table-then-view here is the view<->table
-- inversion deadlock measured on migration 721. Same fix as 721/1110: take every
-- lock up front, views first, then the base table. (A BEGIN/ROLLBACK dry-run of
-- an earlier draft without this stalled ~20s and failed at the view EXECUTE;
-- its error text was not captured, so lock contention is the inferred cause.)

LOCK TABLE harness_shared.engineer_issues IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.harness_features_consolidated IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.work_items_claimable IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE;

ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS duplicate_of text NULL,
  ADD COLUMN IF NOT EXISTS duplicate_source text NULL,
  ADD COLUMN IF NOT EXISTS duplicate_confidence real NULL,
  ADD COLUMN IF NOT EXISTS duplicate_evidence jsonb NULL;

-- duplicate_confidence / duplicate_evidence (R-4, P-005) make the verdict
-- auditable on the row itself: the writer's match score in [0,1] and what it
-- matched on (e.g. {"matchedOn":"structural-key","key":"..."} or
-- {"matchedOn":"similarity","score":0.94}). They live on the base table only;
-- the gate reads duplicate_of alone, so the views below carry just the verdict
-- and its writer. Neither may exist without a verdict.
ALTER TABLE harness_shared.work_items
  DROP CONSTRAINT IF EXISTS work_items_duplicate_detail_check;
-- FORWARD-COMPAT: the deployed release never writes these columns, so this CHECK cannot reject any of its writes.
ALTER TABLE harness_shared.work_items
  ADD CONSTRAINT work_items_duplicate_detail_check
  CHECK (
    (duplicate_confidence IS NULL OR (duplicate_of IS NOT NULL AND duplicate_confidence >= 0 AND duplicate_confidence <= 1))
    AND (duplicate_evidence IS NULL OR duplicate_of IS NOT NULL)
  );

ALTER TABLE harness_shared.work_items
  DROP CONSTRAINT IF EXISTS work_items_duplicate_source_check;
-- FORWARD-COMPAT: the deployed release never writes duplicate_source, so a CHECK on a brand-new nullable column cannot reject any of its writes.
ALTER TABLE harness_shared.work_items
  ADD CONSTRAINT work_items_duplicate_source_check
  CHECK (
    duplicate_source IS NULL
    OR duplicate_source IN ('create-exact', 'admission-promoter', 'fold', 'agent')
  );

ALTER TABLE harness_shared.work_items
  DROP CONSTRAINT IF EXISTS work_items_duplicate_of_not_self;
-- FORWARD-COMPAT: the deployed release never writes duplicate_of, so this CHECK cannot reject any of its writes.
ALTER TABLE harness_shared.work_items
  ADD CONSTRAINT work_items_duplicate_of_not_self
  CHECK (duplicate_of IS NULL OR duplicate_of <> feature_id);

-- The claimable predicate filters on duplicate_of IS NULL for open rows; the
-- fold and the canonical-occurrence count look rows up by their canonical.
CREATE INDEX IF NOT EXISTS work_items_duplicate_of_idx
  ON harness_shared.work_items (workspace_id, duplicate_of)
  WHERE duplicate_of IS NOT NULL;

-- The admission predicate (work-items-admission.ts admittedWhereSql) runs over
-- the base table AND the engineer_issues / harness_features_consolidated views,
-- and work_items_claimable is the SQL claimable floor. All three list their
-- columns explicitly (a `SELECT wi.*` is frozen to the columns that existed when
-- the view was created), so each is re-created from its OWN current definition
-- with the two columns appended. CREATE OR REPLACE VIEW may only add trailing
-- columns, which keeps every dependent view valid. Patching the live definition
-- rather than restating it means this migration cannot silently revert a column
-- another migration added to these views.
--
-- Same guarded-anchor shape as migration 1110: the top-level FROM line of a
-- pg_get_viewdef rendering is exactly "\n   FROM harness_shared.work_items"
-- (three spaces; nested subqueries indent deeper). Anything other than exactly
-- one occurrence fails loudly instead of patching the wrong clause.
--
-- work_items_claimable also gains the gate itself: a row carrying ANY duplicate
-- verdict is never claimable (D-001: a non-null duplicate_of means "this problem
-- already has a row"; whether the canonical is still open does not matter). The
-- view's existing WHERE is wrapped in parentheses before the gate is appended,
-- so the result is correct even if that WHERE later gains a top-level OR.
DO $mig1534_views$
DECLARE
  v            text;
  def          text;
  patched      text;
  from_anchor  CONSTANT text := E'\n   FROM harness_shared.work_items';
  where_anchor CONSTANT text := E'\n  WHERE ';
  hits         integer;
BEGIN
  FOREACH v IN ARRAY ARRAY['engineer_issues', 'harness_features_consolidated', 'work_items_claimable'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name = v
         AND column_name = 'duplicate_of'
    ) THEN
      RAISE NOTICE '1534: % already exposes duplicate_of; view no-op', v;
      CONTINUE;
    END IF;

    SELECT pg_get_viewdef(c.oid)
      INTO def
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = v
       AND c.relkind = 'v';

    IF def IS NULL THEN
      RAISE EXCEPTION '1534: harness_shared.% view not found', v;
    END IF;

    hits := (length(def) - length(replace(def, from_anchor, ''))) / length(from_anchor);
    IF hits <> 1 THEN
      RAISE EXCEPTION
        '1534: expected exactly one top-level work_items FROM anchor in %, found %; re-derive the view patch instead of forcing it',
        v, hits;
    END IF;

    patched := replace(def, from_anchor, E',\n    duplicate_of,\n    duplicate_source' || from_anchor);

    IF v = 'work_items_claimable' THEN
      hits := (length(patched) - length(replace(patched, where_anchor, ''))) / length(where_anchor);
      IF hits <> 1 THEN
        RAISE EXCEPTION
          '1534: expected exactly one top-level WHERE in work_items_claimable, found %; re-derive the gate patch instead of forcing it',
          hits;
      END IF;
      patched := rtrim(replace(patched, where_anchor, where_anchor || '('), E'; \n')
                 || ') AND duplicate_of IS NULL';
    END IF;

    EXECUTE format('CREATE OR REPLACE VIEW harness_shared.%I AS %s', v, patched);
  END LOOP;
END
$mig1534_views$;

-- Post-conditions, so an idempotent re-run verifies the installed state instead
-- of treating IF NOT EXISTS / the per-view no-op as proof the shape is right.
DO $mig1534_check$
DECLARE
  n integer;
BEGIN
  SELECT count(*)::int
    INTO n
    FROM information_schema.columns
   WHERE table_schema = 'harness_shared'
     AND table_name = 'work_items'
     AND column_name IN ('duplicate_of', 'duplicate_source')
     AND data_type = 'text'
     AND is_nullable = 'YES';
  IF n <> 2 THEN
    RAISE EXCEPTION '1534: expected two nullable text duplicate columns on work_items, found %', n;
  END IF;

  SELECT count(*)::int
    INTO n
    FROM information_schema.columns
   WHERE table_schema = 'harness_shared'
     AND table_name = 'work_items'
     AND is_nullable = 'YES'
     AND ((column_name = 'duplicate_confidence' AND data_type = 'real')
       OR (column_name = 'duplicate_evidence' AND data_type = 'jsonb'));
  IF n <> 2 THEN
    RAISE EXCEPTION '1534: expected nullable duplicate_confidence real + duplicate_evidence jsonb on work_items, found %', n;
  END IF;

  SELECT count(*)::int
    INTO n
    FROM information_schema.columns
   WHERE table_schema = 'harness_shared'
     AND table_name IN ('engineer_issues', 'harness_features_consolidated', 'work_items_claimable')
     AND column_name IN ('duplicate_of', 'duplicate_source');
  IF n <> 6 THEN
    RAISE EXCEPTION '1534: expected the three work_items views to expose both duplicate columns (6), found %', n;
  END IF;

  IF position('duplicate_of IS NULL' IN pg_get_viewdef('harness_shared.work_items_claimable'::regclass)) = 0 THEN
    RAISE EXCEPTION '1534: work_items_claimable does not carry the duplicate_of IS NULL gate';
  END IF;
END
$mig1534_check$;

COMMENT ON COLUMN harness_shared.work_items.duplicate_of IS
  'feature_id of the canonical work item this row duplicates (same workspace). Read by the admission predicate: a row with any non-null duplicate_of is never claimable. bug-inflow-one-problem-one-row-2026-10-18#D-001.';
COMMENT ON COLUMN harness_shared.work_items.duplicate_source IS
  'Writer that set duplicate_of: create-exact | admission-promoter | fold | agent.';
COMMENT ON COLUMN harness_shared.work_items.duplicate_confidence IS
  'Writer match score in [0,1] for the duplicate_of verdict (1 = exact structural key). NULL when duplicate_of is NULL.';
COMMENT ON COLUMN harness_shared.work_items.duplicate_evidence IS
  'What the writer matched on, e.g. {"matchedOn":"structural-key","key":"..."} or {"matchedOn":"similarity","score":0.94}. NULL when duplicate_of is NULL.';
