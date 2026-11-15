-- EI-28839855241414904: retain complete semantic input beside bounded digest identities.
ALTER TABLE harness_shared.code_intel_pushes
  ADD COLUMN IF NOT EXISTS source_record jsonb;
ALTER TABLE harness_shared.code_intel_push_skips
  ADD COLUMN IF NOT EXISTS source_record jsonb;

COMMENT ON COLUMN harness_shared.code_intel_pushes.source_record IS
  'Complete semantic source behind a digest subject; recover by workspace_id and subject.';
COMMENT ON COLUMN harness_shared.code_intel_push_skips.source_record IS
  'Complete semantic source for an omitted fact; recover by workspace_id and subject.';
