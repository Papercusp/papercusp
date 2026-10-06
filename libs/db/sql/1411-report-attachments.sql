-- 1411: the consented-attachment store for problem reports
-- (plan unified-bug-pipeline-and-honest-queue-2026-10-05, P-014 / WI-10006228, decisions D-013, D-048).
--
-- A reporter attaches a log excerpt, a text snippet, a screenshot or a file only when they tick it
-- in the preview (D-013). The report text lives on the work item; the attachment lives here, so it
-- can be deleted 90 days after the item closes while the text stays. One store for every door:
-- the desktop "Report a problem" dialog writes door 'desktop'; the Slack door
-- (slack-messages-to-bug-reports-2026-10-05 P-005) writes door 'chat'.
--
-- redaction: redacted        text kinds; the writer re-ran redactSensitiveText before storing
--            not-redactable  images and opaque files; stored as received, marked so no reader
--                            treats them as scrubbed
--
-- external_id makes a retried write idempotent: unique per door when present.
-- work_item_id has no foreign key on purpose: the deletion sweep removes rows whose item closed
-- more than 90 days ago, and rows whose item no longer exists.
--
-- Additive only: one new table, its indexes and its policy.
-- FORWARD-COMPAT: the table is new in this migration, so no deployed release reads it or relies on the partial unique index; the writer names the predicate in its ON CONFLICT clause.

CREATE TABLE IF NOT EXISTS harness_shared.report_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  text NOT NULL,
  work_item_id  text NOT NULL,
  door          text NOT NULL CHECK (door ~ '^[a-z][a-z0-9-]{0,31}$'),
  kind          text NOT NULL CHECK (kind IN ('log', 'text', 'screenshot', 'file')),
  external_id   text CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 256),
  mime          text NOT NULL CHECK (length(mime) BETWEEN 1 AND 128),
  byte_size     integer NOT NULL CHECK (byte_size BETWEEN 0 AND 2097152),
  content       bytea NOT NULL,
  redaction     text NOT NULL CHECK (redaction IN ('redacted', 'not-redactable')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(content) = byte_size),
  CHECK (kind NOT IN ('log', 'text') OR redaction = 'redacted')
);

CREATE UNIQUE INDEX IF NOT EXISTS report_attachments_door_external_uq
  ON harness_shared.report_attachments (workspace_id, door, external_id)
  WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS report_attachments_item_idx
  ON harness_shared.report_attachments (workspace_id, work_item_id);

COMMENT ON TABLE harness_shared.report_attachments IS
  'unified-bug-pipeline D-013/D-048: attachments a reporter ticked in the preview (log, text, screenshot, file), one store for every report door. Deleted 90 days after the work item closes; the report text stays on the item.';

ALTER TABLE harness_shared.report_attachments ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'harness_shared'
       AND tablename = 'report_attachments'
       AND policyname = 'report_attachments_workspace_isolation'
  ) THEN
    CREATE POLICY report_attachments_workspace_isolation
      ON harness_shared.report_attachments
      USING (workspace_id = current_setting('app.workspace_id'::text, true))
      WITH CHECK (workspace_id = current_setting('app.workspace_id'::text, true));
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.report_attachments TO harness_app;
