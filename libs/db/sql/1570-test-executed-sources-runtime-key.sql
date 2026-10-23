-- P005 / node-to-bun-staged-migration-2026-10-22: retain each runtime's pass proof.
-- Migration 1552 scoped proofs by context and object store. Its key still makes a
-- successful Bun recording at the same source SHA collide with Node. The writer's
-- target-less ON CONFLICT DO NOTHING then silently discards the second runtime.
-- Existing runtime-scoped DELETEs and readers need both rows to survive.
--
-- Widen the existing unique constraint, preserving the deployed writer's
-- target-less conflict clause. NULL remains a single legacy/unknown identity;
-- readers require an explicit identity and never reuse that unknown bucket.
-- FORWARD-COMPAT: the replacement is a unique constraint over a superset of
-- migration 1552's columns. Deployed reporters use target-less ON CONFLICT DO
-- NOTHING and never name this constraint; their inserts remain valid before
-- and after this migration. The maintained real-PG writer suite verifies both
-- existing context/install isolation and the new runtime coexistence behavior.
ALTER TABLE harness_shared.test_executed_sources
  DROP CONSTRAINT IF EXISTS test_executed_sources_proof_key;

ALTER TABLE harness_shared.test_executed_sources
  ADD CONSTRAINT test_executed_sources_proof_key
  UNIQUE NULLS NOT DISTINCT
    (workspace_name, test_file, recorded_sha, run_context, recorded_git_dir, runner_identity);

COMMENT ON COLUMN harness_shared.test_executed_sources.runner_identity IS
  'Runtime proof identity of the recording worker. Part of the proof key; readers match an explicit identity before choosing the newest row. NULL is legacy/unknown, never reusable.';
