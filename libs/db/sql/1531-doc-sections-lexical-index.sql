-- 1531 — Index the doc_sections lexical predicate used by docs:search.
--
-- The doc source ranks over `to_tsvector('english', title || E'\n' || content)`.
-- Without a matching GIN expression index PostgreSQL scans every visible section,
-- and the 1.5s read deadline turns that scan into source timeouts as the corpus grows.
-- Keep the expression byte-compatible with knowledge-sources.ts so the planner can
-- use this index for both the match predicate and the ranking query.

CREATE INDEX IF NOT EXISTS doc_sections_lexical_search_idx
  ON harness_shared.doc_sections
  USING gin (to_tsvector('english'::regconfig, title || E'\n'::text || content));
