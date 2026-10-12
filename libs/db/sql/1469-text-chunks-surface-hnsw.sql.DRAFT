-- 1469 — per-surface HNSW indexes for the remaining shared chunk collections.
-- WI-10005483; bm25-lexical-search-evoke-adoption-2026-10-10 D-046/D-047.
--
-- The default ANN chunk leg now uses the same validated surface literal as the
-- consult leg (migration 1341), so PostgreSQL can match a partial index even
-- under a generic prepared plan. The global index otherwise traverses vectors
-- belonging to other surfaces before applying the surface filter. The retained
-- D-046 diagnostic measured 6260 chunk-leg reads and 2477 discarded rows on one
-- work-item query; this migration does not itself claim a latency/recall pass.
--
-- Keep the global index as a fallback for newly registered surfaces and retain
-- the existing consult index. These indexes add no collection, key or vector
-- space; query-side workspace, membership and profile filters still apply.
--
-- The migration runner wraps each file in a transaction. As in migration 1454,
-- pre-build these indexes CONCURRENTLY on an existing large corpus before
-- arming/applying this file. IF NOT EXISTS then makes replay a no-op there;
-- fresh/embedded databases build their small indexes inline.

CREATE INDEX IF NOT EXISTS text_chunks_work_items_embedding_hnsw_idx
  ON harness_shared.text_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE surface = 'work_items';

CREATE INDEX IF NOT EXISTS text_chunks_plans_embedding_hnsw_idx
  ON harness_shared.text_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE surface = 'plans';

CREATE INDEX IF NOT EXISTS text_chunks_operator_turns_embedding_hnsw_idx
  ON harness_shared.text_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE surface = 'operator_turns';

CREATE INDEX IF NOT EXISTS text_chunks_report_embedding_hnsw_idx
  ON harness_shared.text_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE surface = 'report';
