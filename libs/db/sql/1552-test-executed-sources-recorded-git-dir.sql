-- 1552-test-executed-sources-recorded-git-dir.sql — scope pass proofs to the object store that recorded them
-- WI-6554700010019324 (owner directive #2143 part 2).
--
-- Several installs on this box clone the same repository (papercusp, papercusp-pr-drill-*), so
-- they share workspace names and run contexts. Nothing in a row said which checkout recorded it,
-- and every recording's retention DELETE (same workspace, file and run context, another sha)
-- removed the sibling install's proofs. Readers then took the sibling's row at a sha their own
-- repository cannot resolve, and reuse fell to unknown drift (measured 2026-10-21: web reused 0
-- of 882, all at pr-drill sha d324441f).
--
--   recorded_git_dir  realpath of the recording checkout's git common dir: the object store that
--                     can resolve recorded_sha. A writer deletes only rows carrying its own
--                     value; a reader prefers its own value and ignores other installs' rows.
--                     NULL = recorded before 1552 (legacy).
--
-- The key gains run_context and recorded_git_dir, so a clean-local and a green-checkpoint proof
-- at one sha, or two installs' proofs at one sha, coexist instead of the later INSERT being
-- dropped by ON CONFLICT DO NOTHING.
--
-- FORWARD-COMPAT: the dropped primary key is replaced in the same migration by a unique
-- constraint over a superset of its columns, and every writer since 2026-10-01 (WI-10004880)
-- inserts with a target-less ON CONFLICT DO NOTHING, which any unique constraint satisfies; no
-- deployed code names the constraint or targets the old three-column key.

ALTER TABLE harness_shared.test_executed_sources
  ADD COLUMN IF NOT EXISTS recorded_git_dir text;

COMMENT ON COLUMN harness_shared.test_executed_sources.recorded_git_dir IS
  'realpath of the recording checkout''s git common dir (the object store that resolves recorded_sha); writers delete only their own rows, readers prefer them. NULL = recorded before migration 1552.';

ALTER TABLE harness_shared.test_executed_sources
  DROP CONSTRAINT IF EXISTS test_executed_sources_pkey;

ALTER TABLE harness_shared.test_executed_sources
  DROP CONSTRAINT IF EXISTS test_executed_sources_proof_key;

ALTER TABLE harness_shared.test_executed_sources
  ADD CONSTRAINT test_executed_sources_proof_key
  UNIQUE NULLS NOT DISTINCT (workspace_name, test_file, recorded_sha, run_context, recorded_git_dir);
