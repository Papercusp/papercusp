-- Optional retry identity on the existing immutable report row.
-- FORWARD-COMPAT: the deployed publisher never writes request_key, so its rows
-- remain NULL and outside the partial unique index; existing reads are unchanged.
ALTER TABLE harness_shared.report_library
  ADD COLUMN IF NOT EXISTS request_key text;

CREATE UNIQUE INDEX IF NOT EXISTS report_library_request_key_unique
  ON harness_shared.report_library (workspace_id, COALESCE(author_owner_id, ''), request_key)
  WHERE request_key IS NOT NULL;
