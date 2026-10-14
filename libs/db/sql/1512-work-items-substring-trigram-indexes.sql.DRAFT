-- 1512 — trigram indexes for literal work-item q filters (EI-25883110093789830).
--
-- `issues-engineer.ts` preserves substring semantics for work_items:list q across
-- canonical issue title/summary and the lossless occurrence title/body ledger. Those
-- predicates are ILIKE '%literal%' and cannot use the existing full-text indexes.
-- Migration 1512 creates these indexes inline only on small/fresh tables. The
-- sessionSearchIndexBuild workflow creates the same indexes concurrently when the
-- populated live tables exceed this threshold; its long-transaction, disk-headroom,
-- time-budget, and invalid-build recovery guards keep the build online and resumable.
--
-- Each index expression matches its read predicate exactly. Keep names and expressions
-- aligned with ISSUE_Q_SEARCH_INDEXES in packages/operator-core/lib/session-search-index-build.ts.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$
DECLARE
  work_items_small boolean;
  occurrences_small boolean;
BEGIN
  SELECT count(*) <= 10000
    INTO work_items_small
    FROM (SELECT 1 FROM harness_shared.work_items LIMIT 10001) AS probe;

  IF work_items_small THEN
    EXECUTE $sql$CREATE INDEX IF NOT EXISTS work_items_title_substring_trgm_idx
      ON harness_shared.work_items USING gin ((COALESCE(title, '')) gin_trgm_ops)$sql$;
    EXECUTE $sql$CREATE INDEX IF NOT EXISTS work_items_summary_substring_trgm_idx
      ON harness_shared.work_items USING gin ((COALESCE(summary, '')) gin_trgm_ops)$sql$;
  END IF;

  SELECT count(*) <= 10000
    INTO occurrences_small
    FROM (SELECT 1 FROM harness_shared.work_item_occurrences LIMIT 10001) AS probe;

  IF occurrences_small THEN
    EXECUTE $sql$CREATE INDEX IF NOT EXISTS work_item_occurrences_reported_title_trgm_idx
      ON harness_shared.work_item_occurrences USING gin (reported_title gin_trgm_ops)$sql$;
    EXECUTE $sql$CREATE INDEX IF NOT EXISTS work_item_occurrences_evidence_body_trgm_idx
      ON harness_shared.work_item_occurrences USING gin ((COALESCE(evidence ->> 'body', '')) gin_trgm_ops)$sql$;
  END IF;
END $$;
