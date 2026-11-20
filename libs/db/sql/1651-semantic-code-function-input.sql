-- Existing rows remain readable. A missing fingerprint requires fresh inference
-- at the next changed generation. Only the current refresh may publish it.
ALTER TABLE harness_shared.semantic_code_files
  ADD COLUMN IF NOT EXISTS refresh_id uuid;
ALTER TABLE harness_shared.semantic_code_functions
  ADD COLUMN IF NOT EXISTS input_sha256 text;
