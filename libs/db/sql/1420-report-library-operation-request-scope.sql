-- Extend the existing publisher's retry namespace; provenance remains immutable.
-- Null preserves ordinary author-scoped keys, including rows written by an
-- older publisher during rollout. No stored report body or origin is rewritten.
-- Measured: git show d740fc3802:packages/operator-core/lib/report-library.ts
-- uses plain INSERT (line 319), with no ON CONFLICT arbiter or request_key.
-- Current report-library.ts likewise uses an advisory lock plus plain INSERT.
-- FORWARD-COMPAT: neither deployed nor current publisher uses ON CONFLICT on
-- this index. The replacement retains exactly the old author/key uniqueness
-- for every old writer (request_scope defaults NULL), including existing rows.
-- Only the new host-verified operation writer supplies a non-NULL namespace.
-- lint-migrations: allow-index-swap No ON CONFLICT consumer; NULL scope preserves the old author/key constraint and production-migration PG coverage tests legacy writes.
ALTER TABLE harness_shared.report_library
  ADD COLUMN IF NOT EXISTS request_scope text;

CREATE UNIQUE INDEX IF NOT EXISTS report_library_request_scope_key_unique
  ON harness_shared.report_library (
    workspace_id,
    (COALESCE(request_scope, 'author:' || COALESCE(author_owner_id, ''))),
    request_key
  ) WHERE request_key IS NOT NULL;

-- A worker can publish the same key for independent accepted operations;
-- scope, rather than the changing worker identity, defines their independence.
DROP INDEX IF EXISTS harness_shared.report_library_request_key_unique;
