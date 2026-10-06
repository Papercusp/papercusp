-- 1400: per-source push secrets for provider webhooks
-- (plan linear-asana-task-sync-2026-10-05, P-008 / WI-10006368, decision D-016).
--
-- A connector source whose provider declares a push scheme (provider.push in the plugin
-- manifest) receives the provider's own webhooks at POST /api/hooks/<source id>. Asana sends one
-- secret per webhook, in an `X-Hook-Secret` handshake while the webhook is being created, and
-- signs every later delivery with it. A source with several configured projects holds several
-- webhooks, so it holds several secrets: trigger_webhook_secrets keeps exactly one row per
-- (generic) webhook source and is not reused.
--
-- Each secret is stored encrypted with pgcrypto under the operator database key, as 1269 does,
-- and decrypted only server-side when a delivery is verified. A verified delivery only wakes the
-- source's next sync (D-003); nothing here is a data path. Deleting the source deletes its
-- secrets. Row-level security bounds the table to the caller's workspace like every source table.
--
-- Additive only: one new table, its index and its policy.

CREATE TABLE IF NOT EXISTS harness_shared.connector_push_secrets (
  id            uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id  text NOT NULL,
  source_id     uuid NOT NULL,
  secret_ct     bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connector_push_secrets_source_fk
    FOREIGN KEY (workspace_id, source_id)
    REFERENCES harness_shared.data_sources (workspace_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS connector_push_secrets_source_idx
  ON harness_shared.connector_push_secrets (workspace_id, source_id, created_at DESC);

COMMENT ON TABLE harness_shared.connector_push_secrets IS
  'linear-asana-task-sync D-016: the push secrets of one connector source (one per remote webhook, e.g. per Asana project), pgcrypto-encrypted under the operator database key. A delivery verifies against any of them; a verified delivery only wakes the source''s next sync.';

ALTER TABLE harness_shared.connector_push_secrets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'harness_shared'
       AND tablename = 'connector_push_secrets'
       AND policyname = 'connector_push_secrets_workspace_isolation'
  ) THEN
    CREATE POLICY connector_push_secrets_workspace_isolation
      ON harness_shared.connector_push_secrets
      USING (workspace_id = current_setting('app.workspace_id'::text, true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id'::text, true));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.connector_push_secrets TO harness_app;
