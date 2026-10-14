-- 1500-chat-rollup-queue-failure-state.sql
--
-- WI-6554700010012111 (follow-up to WI-6554700010011913).
--
-- rollupChatUnits renders each queued chat bucket in its own savepoint and re-queues a bucket
-- whose render throws. Until now the re-queue used a fixed 300s delay and kept no record of
-- earlier failures, so a bucket that fails on every attempt retried forever and was reported as
-- a connector-sync soft error every time it came due.
--
-- These columns let rollupChatUnits back off and then stop:
--   attempts          consecutive failed renders since the bucket last rendered (or was revived)
--   last_error        the latest render error (rollupChatUnits truncates it to ~500 chars)
--   first_failed_at   when the current run of failures began
--   dead_lettered_at  set when attempts reaches the cap; rollupChatUnits no longer dequeues the row
--
-- The retry delay doubles with each attempt up to a cap (constants in
-- packages/operator-core/lib/data-sources/chat-retrieval-units.ts). The row stays dequeued while
-- dead_lettered_at is set, so its failure is reported once.
--
-- A dead-lettered bucket is revived (failure state cleared, due now) when:
--   * a message write touches it: enqueue() in chat-retrieval-units.ts upserts instead of
--     ON CONFLICT DO NOTHING when the existing row is dead-lettered. A row still in backoff is
--     left alone, so a channel that keeps receiving messages still reaches the cap;
--   * its data source's routing changes: the 1326 trigger function below now clears any failure
--     state (backoff or dead-letter) on conflict, because a routing change can fix a render error.
--
-- No index: the dequeue already filters by workspace_id (the primary key's leading column), the
-- queue is drained every sync (0 rows when this was written), and dead-lettered rows are
-- bounded by the number of permanently failing buckets.
--
-- Additive: four nullable or defaulted columns (ADD COLUMN with a constant default does not
-- rewrite the table) and a CREATE OR REPLACE of an existing trigger function. Re-runnable.

ALTER TABLE harness_shared.chat_rollup_queue
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS first_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;

DO $chk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chat_rollup_queue_attempts_check'
       AND conrelid = 'harness_shared.chat_rollup_queue'::regclass
  ) THEN
    ALTER TABLE harness_shared.chat_rollup_queue
      ADD CONSTRAINT chat_rollup_queue_attempts_check CHECK (attempts >= 0);
  END IF;
END;
$chk$;

COMMENT ON COLUMN harness_shared.chat_rollup_queue.attempts IS
  'WI-6554700010012111: consecutive failed renders of this bucket since it last rendered or was revived.';
COMMENT ON COLUMN harness_shared.chat_rollup_queue.last_error IS
  'WI-6554700010012111: the latest render error for this bucket (truncated by rollupChatUnits).';
COMMENT ON COLUMN harness_shared.chat_rollup_queue.first_failed_at IS
  'WI-6554700010012111: when the current run of failed renders began.';
COMMENT ON COLUMN harness_shared.chat_rollup_queue.dead_lettered_at IS
  'WI-6554700010012111: set when attempts reached the cap; rollupChatUnits skips the row until a message write or a routing change revives it.';

-- 1326's trigger function, with ON CONFLICT now clearing failure state. Identical otherwise.
CREATE OR REPLACE FUNCTION harness_shared.data_sources_requeue_chat_buckets()
RETURNS trigger
LANGUAGE plpgsql
AS $requeue$
BEGIN
  INSERT INTO harness_shared.chat_rollup_queue AS q
    (workspace_id, data_source_id, channel_id, bucket_kind, bucket_key)
  SELECT DISTINCT
         u.workspace_id,
         u.data_source_id,
         u.channel_id,
         CASE u.unit_kind WHEN 'thread' THEN 'thread' ELSE 'day' END,
         u.bucket_key
    FROM harness_shared.chat_retrieval_units AS u
   WHERE u.workspace_id = NEW.workspace_id
     AND u.data_source_id = NEW.id
  ON CONFLICT (workspace_id, data_source_id, channel_id, bucket_kind, bucket_key) DO UPDATE
     SET attempts = 0,
         last_error = NULL,
         first_failed_at = NULL,
         dead_lettered_at = NULL,
         queued_at = now()
   WHERE q.attempts > 0 OR q.dead_lettered_at IS NOT NULL;
  RETURN NULL;
END;
$requeue$;

COMMENT ON FUNCTION harness_shared.data_sources_requeue_chat_buckets() IS
  'WI-10005117: re-queue every chat_rollup_queue bucket of a data source whose routing columns changed, so rollupChatUnits moves existing units to the new destination without waiting for a new message. WI-6554700010012111: also clears a bucket''s backoff or dead-letter state, since a routing change can fix a render error.';
