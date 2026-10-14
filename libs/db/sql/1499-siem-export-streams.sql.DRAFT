-- 1499-siem-export-streams.sql
-- P-008b (plan papercusp-enterprise-readiness-roadmap-2026-10-09, WI-6554700010012184; decision D-018).
--
-- Server-side state for the SIEM export delivery surface (siem-export-delivery.ts):
--   1. siem_export_streams: one row per exported stream — the tool-invocation stream of a
--      workspace ('papercusp.siem-export:<workspaceId>') or the organization audit stream of an
--      organization ('papercusp.siem-export.org-audit:<organizationId>'). It holds the last
--      ACKNOWLEDGED cursor and chain head, so a consumer that loses its own state can resume, and
--      the id of the pseudonym key the stream was exported under (a rotation is visible).
--      Only an acknowledgement advances it, with a compare-and-set on the stored cursor.
--   2. siem_export_deliveries: append-only record of every acknowledged batch. The
--      (stream_id, idempotency_key) pair is unique, so a replayed acknowledgement cannot record twice.
--   3. An (organization_id, recorded_at, id) index on organization_audit_events: the org stream
--      pages by recorded_at (the time the row became visible), not occurred_at.
--
-- Additive only: new tables, functions, triggers and an index. Nothing the deployed release reads changes.

CREATE TABLE IF NOT EXISTS harness_shared.siem_export_streams (
  stream_id         text        PRIMARY KEY,
  kind              text        NOT NULL CHECK (kind IN ('tool-invocations', 'org-audit')),
  workspace_id      text,
  organization_id   uuid,
  cursor            text        NOT NULL DEFAULT '0' CHECK (length(btrim(cursor)) > 0),
  head              jsonb,
  key_id            text        CHECK (key_id IS NULL OR key_id ~ '^k:[0-9a-f]{16}$'),
  delivered_batches bigint      NOT NULL DEFAULT 0 CHECK (delivered_batches >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT siem_export_streams_subject_ck CHECK (
    (kind = 'tool-invocations'
      AND workspace_id IS NOT NULL AND length(btrim(workspace_id)) > 0 AND organization_id IS NULL
      AND stream_id = 'papercusp.siem-export:' || workspace_id)
    OR
    (kind = 'org-audit'
      AND organization_id IS NOT NULL AND workspace_id IS NULL
      AND stream_id = 'papercusp.siem-export.org-audit:' || organization_id::text)
  ),
  -- The head is the full hash-chain link the next batch continues from (ChainLink).
  CONSTRAINT siem_export_streams_head_ck CHECK (
    head IS NULL
    OR (
      jsonb_typeof(head) = 'object'
      AND jsonb_typeof(head -> 'seq') = 'number'
      AND jsonb_typeof(head -> 'entryHash') = 'string'
      AND jsonb_typeof(head -> 'prevHash') = 'string'
      AND jsonb_typeof(head -> 'entryDigest') = 'string'
      AND head ->> 'streamId' = stream_id
    )
  ),
  -- An empty batch is never acknowledged, so every acknowledgement advances the chain:
  -- the head is NULL exactly while nothing has been delivered.
  CONSTRAINT siem_export_streams_head_iff_delivered_ck CHECK ((head IS NULL) = (delivered_batches = 0))
);

CREATE INDEX IF NOT EXISTS siem_export_streams_organization_idx
  ON harness_shared.siem_export_streams (organization_id)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS siem_export_streams_workspace_idx
  ON harness_shared.siem_export_streams (workspace_id)
  WHERE workspace_id IS NOT NULL;

-- A stream's identity never changes, it is never deleted, and it only moves forward.
CREATE OR REPLACE FUNCTION harness_shared.siem_export_streams_forward_only()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'siem_export_streams rows are never deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.stream_id IS DISTINCT FROM OLD.stream_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'siem_export_streams identity columns are immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.delivered_batches < OLD.delivered_batches THEN
    RAISE EXCEPTION 'siem_export_streams.delivered_batches cannot decrease' USING ERRCODE = '55000';
  END IF;
  IF OLD.head IS NOT NULL AND (
       NEW.head IS NULL OR (NEW.head ->> 'seq')::numeric < (OLD.head ->> 'seq')::numeric
     ) THEN
    RAISE EXCEPTION 'siem_export_streams.head cannot move backwards' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS siem_export_streams_forward_only_trg ON harness_shared.siem_export_streams;
CREATE TRIGGER siem_export_streams_forward_only_trg
  BEFORE UPDATE OR DELETE ON harness_shared.siem_export_streams
  FOR EACH ROW EXECUTE FUNCTION harness_shared.siem_export_streams_forward_only();

CREATE TABLE IF NOT EXISTS harness_shared.siem_export_deliveries (
  delivery_id       text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  stream_id         text        NOT NULL REFERENCES harness_shared.siem_export_streams (stream_id),
  idempotency_key   text        NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  cursor_from       text        NOT NULL CHECK (length(btrim(cursor_from)) > 0),
  cursor_to         text        NOT NULL CHECK (length(btrim(cursor_to)) > 0),
  length            integer     NOT NULL CHECK (length > 0),
  head_seq          bigint      NOT NULL CHECK (head_seq >= 0),
  head_entry_hash   text        NOT NULL CHECK (head_entry_hash ~ '^[0-9a-f]{64}$'),
  key_id            text        CHECK (key_id IS NULL OR key_id ~ '^k:[0-9a-f]{16}$'),
  acknowledged_by   text        NOT NULL CHECK (length(btrim(acknowledged_by)) > 0),
  acknowledged_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT siem_export_deliveries_cursor_moves_ck CHECK (cursor_to <> cursor_from),
  CONSTRAINT siem_export_deliveries_idempotency_uq UNIQUE (stream_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS siem_export_deliveries_stream_time_idx
  ON harness_shared.siem_export_deliveries (stream_id, acknowledged_at DESC);

CREATE OR REPLACE FUNCTION harness_shared.siem_export_deliveries_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  RAISE EXCEPTION 'siem_export_deliveries is append-only; % is forbidden', TG_OP USING ERRCODE = '55000';
END;
$guard$;

DROP TRIGGER IF EXISTS siem_export_deliveries_append_only_trg ON harness_shared.siem_export_deliveries;
CREATE TRIGGER siem_export_deliveries_append_only_trg
  BEFORE UPDATE OR DELETE ON harness_shared.siem_export_deliveries
  FOR EACH ROW EXECUTE FUNCTION harness_shared.siem_export_deliveries_append_only();

-- The org-audit stream pages (recorded_at, id) ascending within one organization.
CREATE INDEX IF NOT EXISTS organization_audit_events_export_idx
  ON papercusp_auth.organization_audit_events (organization_id, recorded_at, id);
