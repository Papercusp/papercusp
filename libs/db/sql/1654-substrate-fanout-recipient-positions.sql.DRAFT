-- The retry ledger records failures. Successful inbox notifications can be
-- collected before an older DBOS workflow recovers. Retain one version for
-- each recipient and reference across both inbox delivery and item reads.
CREATE TABLE IF NOT EXISTS harness_shared.substrate_fanout_recipient_positions (
  workspace_id  text   NOT NULL,
  subscriber_id text   NOT NULL,
  subject       text   NOT NULL,
  outbox_id     bigint NOT NULL,
  PRIMARY KEY (workspace_id, subscriber_id, subject)
);

-- Restore known positions from pre-migration writes. Only the exact
-- substrate fan-out message ID identifies a version in the legacy inbox.
WITH inbox AS (
  SELECT e.workspace_id, e.writer_key AS subscriber_id, e.body->>'subject' AS subject,
         e.msg_id, substring(e.msg_id FROM '^fan-([0-9]{1,19})-')::numeric AS version
    FROM harness_shared.coord_event_log AS e
   WHERE e.surface = 'messages' AND e.body->>'kind' = 'notify'
     AND e.body->>'from' = 'substrate' AND e.body->>'subject' IS NOT NULL
     AND e.msg_id LIKE 'fan-%'
), written AS (
  SELECT workspace_id, subscriber_id, subject, version AS outbox_id FROM inbox
   WHERE version BETWEEN 1 AND 9223372036854775807
     AND msg_id = 'fan-' || version::text || '-' || subscriber_id
  UNION ALL
  SELECT workspace_id, subscriber_id, object_kind || ':' || object_ref, outbox_id
    FROM harness_shared.substrate_fanout_deliveries WHERE state = 'written'
)
INSERT INTO harness_shared.substrate_fanout_recipient_positions AS p
  (workspace_id, subscriber_id, subject, outbox_id)
SELECT workspace_id, subscriber_id, subject, max(outbox_id)::bigint FROM written
 GROUP BY workspace_id, subscriber_id, subject
ON CONFLICT (workspace_id, subscriber_id, subject) DO UPDATE SET outbox_id = EXCLUDED.outbox_id
 WHERE p.outbox_id < EXCLUDED.outbox_id;
