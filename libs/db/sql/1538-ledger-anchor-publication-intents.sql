-- WI-6554700010018135: the append-only ledger_anchors table cannot represent
-- an in-flight publication. Keep its signed transaction and completion receipt
-- in an associated intent row, so recovery never chooses an unrelated nonce.
-- FORWARD-COMPAT: ledger_anchor_publications is a new table with no old writer;
-- its nonce uniqueness cannot reject writes made by the currently deployed release.
CREATE TABLE IF NOT EXISTS harness_shared.ledger_anchor_publications (
  workspace_id text NOT NULL,
  window_end bigint NOT NULL CHECK (window_end >= 0),
  attempt jsonb NOT NULL CHECK (jsonb_typeof(attempt->'publication') = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, window_end)
);
ALTER TABLE harness_shared.ledger_anchor_publications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ledger_anchor_publications_workspace_isolation ON harness_shared.ledger_anchor_publications;
CREATE POLICY ledger_anchor_publications_workspace_isolation
  ON harness_shared.ledger_anchor_publications FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE UNIQUE INDEX IF NOT EXISTS ledger_anchor_publications_signer_nonce
  ON harness_shared.ledger_anchor_publications (
    (attempt->'prepared'->>'chainId'), (attempt->'prepared'->>'attester'), (attempt->'prepared'->>'nonce')
  ) WHERE attempt->'prepared' IS NOT NULL;
GRANT SELECT, INSERT, UPDATE ON harness_shared.ledger_anchor_publications TO harness_app, harness_admin;
COMMENT ON TABLE harness_shared.ledger_anchor_publications IS
  'Ledger anchor publication intent and replayable signed transaction, persisted before broadcast; no signing keys. WI-6554700010018135.';
