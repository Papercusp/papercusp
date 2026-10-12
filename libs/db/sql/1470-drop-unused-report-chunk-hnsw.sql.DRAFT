-- 1470 — remove the unused report chunk HNSW added by migration 1469.
-- WI-10005483 / EI-25775910693595422; BM25 adoption D-048.
--
-- Index selection in 1469 used surface population before checking readers.
-- report-source.ts ranks eligible chunks exactly with GROUP BY/MIN(distance),
-- so it has no ANN path that can use this index. Retain the work_items, plans,
-- operator_turns and consult_questions partials, plus the global fallback.
-- Do not rewrite applied migration 1469: fresh databases replay this chain too.
--
-- FORWARD-COMPAT: this is neither a constraint nor an ON CONFLICT arbiter.
-- Existing report SQL returns the same rows without the index; no data or
-- ranking behavior changes. The transactional runner uses bounded lock waits,
-- as with migration 1405; CONCURRENTLY cannot run inside its transaction.

DROP INDEX IF EXISTS harness_shared.text_chunks_report_embedding_hnsw_idx;
