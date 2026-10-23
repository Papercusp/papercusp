-- P012: off-hook function vectors; profile and repository are part of every key.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS harness_shared.semantic_code_files (
  workspace_id text NOT NULL,
  repository_id text NOT NULL,
  embedding_profile text NOT NULL,
  path text NOT NULL,
  blob_sha text NOT NULL,
  normalization_version text NOT NULL,
  dimensions integer NOT NULL CHECK (dimensions > 0),
  state text NOT NULL CHECK (state IN ('pending', 'ready', 'failed')),
  PRIMARY KEY (workspace_id, repository_id, embedding_profile, path)
);
CREATE TABLE IF NOT EXISTS harness_shared.semantic_code_functions (
  workspace_id text NOT NULL,
  repository_id text NOT NULL,
  embedding_profile text NOT NULL,
  path text NOT NULL,
  function_id text NOT NULL,
  blob_sha text NOT NULL,
  name text NOT NULL,
  line integer NOT NULL CHECK (line > 0),
  column_number integer NOT NULL CHECK (column_number > 0),
  summary text NOT NULL,
  normalized_body text NOT NULL,
  embedding vector NOT NULL,
  search_text tsvector GENERATED ALWAYS AS
    (to_tsvector('simple', summary || ' ' || normalized_body)) STORED,
  PRIMARY KEY (workspace_id, repository_id, embedding_profile, path, function_id),
  FOREIGN KEY (workspace_id, repository_id, embedding_profile, path)
    REFERENCES harness_shared.semantic_code_files ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS semantic_code_functions_text_idx
  ON harness_shared.semantic_code_functions USING gin (search_text);
-- Unconstrained vector width intentionally supports the selected sidecar profile.
-- A query filters profile + dimensions before measuring cosine; no cross-space ranking.
