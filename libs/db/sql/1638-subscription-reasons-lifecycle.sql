-- 1638 — per-reason subscription lifecycle (shared-reference-system-2026-11-13 P-002, R-8, R-39).
--
-- One (subscriber, target) row in coord_entity_subscriptions now carries every
-- reason that holds it: 'context' (delivered into the subscriber's current
-- context), 'explicit' (asked to follow), 'held_item' (holds the work item) and
-- 'blocker' (generated one-hop blocker follow, WI-4119). Each reason ends
-- independently; the row is cancelled only when its last reason is released.
-- The unique active index and the fan-out read path are unchanged.
--
-- Expand-only: three nullable columns, a column default, a NOT VALID check
-- validated separately, one partial index and one snapshot table. The deployed
-- release never names these columns, so it keeps working unchanged.
--
-- Legacy rows keep reasons = NULL: "reason not recorded (created before P-002)".
-- The store reads NULL as {explicit} for release semantics; the P-002 cleanup
-- snapshots, then cancels NULL-reason rows held by ended sessions and by machine
-- identities (D-002).

ALTER TABLE harness_shared.coord_entity_subscriptions
  ADD COLUMN IF NOT EXISTS reasons text[],
  ADD COLUMN IF NOT EXISTS context_epoch bigint,
  ADD COLUMN IF NOT EXISTS cancel_reason text;

ALTER TABLE harness_shared.coord_entity_subscriptions
  ALTER COLUMN reasons SET DEFAULT ARRAY['explicit']::text[];

COMMENT ON COLUMN harness_shared.coord_entity_subscriptions.reasons IS
  'P-002: every reason holding this subscription (context | explicit | held_item | blocker). NULL = created before P-002, reason not recorded.';
COMMENT ON COLUMN harness_shared.coord_entity_subscriptions.context_epoch IS
  'P-002: the subscriber context epoch that last added the context reason; context replacement ends older epochs.';
COMMENT ON COLUMN harness_shared.coord_entity_subscriptions.cancel_reason IS
  'P-002: why the subscription was cancelled (session-end, session-ended-oracle, context-replaced, release:<reason>, cleanup:<cause>).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'coord_entity_subscriptions_reasons_check'
       AND conrelid = 'harness_shared.coord_entity_subscriptions'::regclass
  ) THEN
    ALTER TABLE harness_shared.coord_entity_subscriptions
      ADD CONSTRAINT coord_entity_subscriptions_reasons_check
      CHECK (reasons IS NULL OR reasons <@ ARRAY['context', 'explicit', 'held_item', 'blocker']::text[])
      NOT VALID;
  END IF;
END $$;

ALTER TABLE harness_shared.coord_entity_subscriptions
  VALIDATE CONSTRAINT coord_entity_subscriptions_reasons_check;

-- Generated blocker follows are the one legacy population whose reason is known.
UPDATE harness_shared.coord_entity_subscriptions
   SET reasons = ARRAY['blocker']::text[]
 WHERE derived_from_kind IS NOT NULL AND cancelled_at IS NULL AND reasons IS NULL;

-- Session end / context replacement cancel one subscriber's contextual rows.
CREATE INDEX IF NOT EXISTS coord_entity_subscriptions_context_idx
  ON harness_shared.coord_entity_subscriptions (workspace_id, subscriber_id, context_epoch)
  WHERE cancelled_at IS NULL AND 'context' = ANY (reasons);

-- Retained snapshot of every row the P-002 cleanup cancels (D-002): the full row
-- as it stood, so a wrong cancellation can be audited and restored.
CREATE TABLE IF NOT EXISTS harness_shared.coord_entity_subscription_cleanup_snapshots (
  snapshot_id    bigserial PRIMARY KEY,
  cleanup_run    text        NOT NULL,
  subscription_id bigint     NOT NULL,
  workspace_id   text        NOT NULL,
  subscriber_id  text        NOT NULL,
  cause          text        NOT NULL,
  row_data       jsonb       NOT NULL,
  snapshotted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cleanup_run, subscription_id)
);

CREATE INDEX IF NOT EXISTS coord_entity_subscription_cleanup_snapshots_sub_idx
  ON harness_shared.coord_entity_subscription_cleanup_snapshots (workspace_id, subscriber_id);
