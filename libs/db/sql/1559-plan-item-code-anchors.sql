-- plan-item-code-anchors-2026-10-20 P-004, D-014.
-- Separate from plan_items: its projection is deleted/reinserted on plan writes.
CREATE TABLE IF NOT EXISTS harness_shared.plan_item_anchors (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  plan_slug text NOT NULL,
  item_id text NOT NULL,
  anchor_kind text NOT NULL CHECK (anchor_kind IN ('symbol','path')),
  requested text NOT NULL,
  symbol_id text,
  symbol_name text,
  path text,
  line integer,
  signature text,
  content_hash text,
  consumers jsonb NOT NULL DEFAULT '[]'::jsonb,
  consumers_total integer NOT NULL DEFAULT 0,
  tests jsonb NOT NULL DEFAULT '[]'::jsonb,
  resolution text NOT NULL CHECK (resolution IN ('resolved','unknown')),
  unknown_reason text,
  freshness text NOT NULL CHECK (freshness IN ('fresh','stale','missing')),
  resolved_commit text,
  stale_since timestamptz,
  stale_notice_id bigint,
  last_checked_at timestamptz,
  last_check_ok boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  CHECK ((resolution='resolved' AND content_hash IS NOT NULL AND unknown_reason IS NULL)
      OR (resolution='unknown' AND unknown_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS plan_item_anchors_plan_idx
  ON harness_shared.plan_item_anchors(workspace_id,harness_slug,plan_slug,item_id);
CREATE INDEX IF NOT EXISTS plan_item_anchors_recheck_idx
  ON harness_shared.plan_item_anchors(last_checked_at NULLS FIRST) WHERE anchor_kind='symbol';

CREATE TABLE IF NOT EXISTS harness_shared.plan_anchor_notices (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  plan_slug text NOT NULL,
  raised_at timestamptz NOT NULL DEFAULT now(),
  audience jsonb NOT NULL,
  anchor_ids jsonb NOT NULL,
  coord_message_id text
);
CREATE INDEX IF NOT EXISTS plan_anchor_notices_plan_idx
  ON harness_shared.plan_anchor_notices(workspace_id,harness_slug,plan_slug,raised_at);

ALTER TABLE harness_shared.plan_item_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.plan_anchor_notices ENABLE ROW LEVEL SECURITY;
-- FORWARD-COMPAT: these policies belong only to the new anchor tables, unused by the older release.
DROP POLICY IF EXISTS plan_item_anchors_workspace ON harness_shared.plan_item_anchors;
CREATE POLICY plan_item_anchors_workspace ON harness_shared.plan_item_anchors
  USING (workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id=current_setting('app.workspace_id',true));
DROP POLICY IF EXISTS plan_anchor_notices_workspace ON harness_shared.plan_anchor_notices;
CREATE POLICY plan_anchor_notices_workspace ON harness_shared.plan_anchor_notices
  USING (workspace_id=current_setting('app.workspace_id',true))
  WITH CHECK (workspace_id=current_setting('app.workspace_id',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON harness_shared.plan_item_anchors,harness_shared.plan_anchor_notices TO harness_app,harness_admin;
GRANT USAGE,SELECT ON SEQUENCE harness_shared.plan_item_anchors_id_seq,harness_shared.plan_anchor_notices_id_seq TO harness_app,harness_admin;
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.plan_item_anchors
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.plan_anchor_notices
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
