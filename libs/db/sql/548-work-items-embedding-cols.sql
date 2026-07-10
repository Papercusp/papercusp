-- Migration 548 — embedding columns for the work-item ledger (P-008,
-- shared-embedding-sidecar-and-enrichment-2026-07-10).
--
-- Adds `embedding vector(384)` + `embedding_mode text` to BOTH work-item
-- kind-tables so work_items:search gains a semantic leg and work_items:create
-- can prescreen new titles against OPEN items by cosine similarity (the
-- 2026-07-10 30-dupe bug-storm class, WI-3358..WI-3477):
--
--   harness_shared.engineer_issues                (issue family: bug/change/task)
--   harness_shared.harness_features_consolidated  (feature family: feature/chunk/…)
--
-- Space discipline (migration 530 / EI-8913): the vector column alone is a
-- trap — `memoryEmbedderMode` picks the embedder at runtime, and two 384-D
-- vectors from different embedders are incomparable noise. `embedding_mode`
-- records WHICH embedder produced each row's vector; the embed-backfill sweep
-- re-embeds rows whose mode IS DISTINCT FROM the active one, and the query
-- side filters `embedding_mode = <active>` so it never ranks against a
-- foreign space. Rows are backfilled by lib/search/embed-backfill.ts (new
-- TARGETS entries, same sweep as the five prose surfaces).
--
-- Dimension: 384 (gemma MRL-384 / BGE / OpenAI-384 — every mode the backfill
-- stores; harrier@1024 is memory-side only and is skipped by the sweep's dims
-- guard). Guarded on pgvector being installed, like 501/530: without the
-- extension the columns are simply not created and every consumer fail-opens
-- to lexical-only.
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; (migration-runner contract; files >=215).

DO $wi_embed$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RETURN;
  END IF;

  ALTER TABLE harness_shared.engineer_issues
    ADD COLUMN IF NOT EXISTS embedding public.vector(384),
    ADD COLUMN IF NOT EXISTS embedding_mode text;
  ALTER TABLE harness_shared.harness_features_consolidated
    ADD COLUMN IF NOT EXISTS embedding public.vector(384),
    ADD COLUMN IF NOT EXISTS embedding_mode text;

  -- Backfill hot predicate (mirrors 530): "rows not in the active space" =
  -- embedding IS NULL OR embedding_mode IS DISTINCT FROM $active. Indexing the
  -- non-null modes keeps that scan cheap once the table has been stamped.
  CREATE INDEX IF NOT EXISTS engineer_issues_embedding_mode_idx
    ON harness_shared.engineer_issues (embedding_mode)
    WHERE embedding_mode IS NOT NULL;
  CREATE INDEX IF NOT EXISTS harness_features_embedding_mode_idx
    ON harness_shared.harness_features_consolidated (embedding_mode)
    WHERE embedding_mode IS NOT NULL;

  -- HNSW cosine for the semantic search leg + the create-time dupe prescreen
  -- (ORDER BY embedding <=> $query LIMIT k). Same shape as memory_vec_* (547).
  CREATE INDEX IF NOT EXISTS engineer_issues_embedding_hnsw_idx
    ON harness_shared.engineer_issues USING hnsw (embedding public.vector_cosine_ops);
  CREATE INDEX IF NOT EXISTS harness_features_embedding_hnsw_idx
    ON harness_shared.harness_features_consolidated USING hnsw (embedding public.vector_cosine_ops);
END
$wi_embed$;
