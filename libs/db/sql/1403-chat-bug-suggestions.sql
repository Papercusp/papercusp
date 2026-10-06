-- 1403: the "looks like a bug" suggestions a chat source sent
-- (plan slack-messages-to-bug-reports-2026-10-05, P-007 / WI-10006379, decisions D-009(d), D-010).
--
-- In a channel with a suggest rule, a person's ordinary post that the local classifier scores as a
-- likely bug report earns its author a private note naming how to report it. Nothing is filed
-- (D-002). The chat admission sink's return value is not persisted (D-009(d)), so this table is
-- the record: one row per suggested message, unique per source + channel + message so a replayed
-- event never sends a second note, plus the per-author cooldown lookup and the counts the
-- admission page shows (P-008). The message text is NOT stored here; chat_messages holds it.
--
-- outcome: pending   claimed, the note is being sent
--          notified  the private note was delivered
--          no-route  nothing was sent: no enabled rule would file a report from this channel, or
--                    no report gesture is switched on there
--          failed    the provider refused the note; error says why
--
-- rule_id names the suggest rule that matched. It has no foreign key on purpose: the record of a
-- sent note outlives the rule. Deleting the data source deletes its suggestions.
--
-- Additive only: one new table, its indexes and its policy.

CREATE TABLE IF NOT EXISTS harness_shared.chat_bug_suggestions (
  id                  uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id        text NOT NULL,
  data_source_id      uuid NOT NULL,
  rule_id             uuid NOT NULL,
  channel_id          text NOT NULL CHECK (btrim(channel_id) <> ''),
  provider_message_id text NOT NULL CHECK (btrim(provider_message_id) <> ''),
  author_external_id  text NOT NULL CHECK (btrim(author_external_id) <> ''),
  score               real NOT NULL,
  classifier_version  text NOT NULL CHECK (btrim(classifier_version) <> ''),
  outcome             text NOT NULL DEFAULT 'pending'
                      CHECK (outcome IN ('pending', 'notified', 'no-route', 'failed')),
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_bug_suggestions_source_fk
    FOREIGN KEY (workspace_id, data_source_id)
    REFERENCES harness_shared.data_sources (workspace_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_bug_suggestions_message_uq
  ON harness_shared.chat_bug_suggestions (workspace_id, data_source_id, channel_id, provider_message_id);

CREATE INDEX IF NOT EXISTS chat_bug_suggestions_author_idx
  ON harness_shared.chat_bug_suggestions (workspace_id, data_source_id, channel_id, author_external_id, created_at DESC);

COMMENT ON TABLE harness_shared.chat_bug_suggestions IS
  'slack-messages-to-bug-reports D-010: one row per "looks like a bug" private note a chat source sent (or declined to send) for a person''s post in a suggest-only channel. Never a bug: only the person''s own report gesture files one.';

ALTER TABLE harness_shared.chat_bug_suggestions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'harness_shared'
       AND tablename = 'chat_bug_suggestions'
       AND policyname = 'chat_bug_suggestions_workspace_isolation'
  ) THEN
    CREATE POLICY chat_bug_suggestions_workspace_isolation
      ON harness_shared.chat_bug_suggestions
      USING (workspace_id = current_setting('app.workspace_id'::text, true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id'::text, true));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.chat_bug_suggestions TO harness_app;
