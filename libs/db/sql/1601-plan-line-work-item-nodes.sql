-- 1601: plan lines become top-level work-item nodes; blocked-by becomes work_item_deps edges.
--
-- Plan one-work-graph-structured-holds-2026-10-26, item P-003 (WI-6554700010030910).
-- Design: one-work-graph-structured-holds-2026-10-26#D-010 (node shape, conversion, edges,
-- findings) and #D-011 (admission/park for created nodes; edge satisfaction 'settled').
--
-- FORWARD-COMPAT: The partial unique index and the new CHECK constraints cover only the plan_* columns this migration adds, which the currently-deployed release never reads or writes, so no live write path can violate them.
--
-- Idempotent: every DDL statement is guarded and the conversion function only touches lines
-- that do not yet have a node, so re-applying this file (or re-calling the function) is a no-op.

-- 1. Node shape: a plan line is a work_items row carrying its plan fields.
ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS plan_slug text,
  ADD COLUMN IF NOT EXISTS plan_line_id text,
  ADD COLUMN IF NOT EXISTS plan_seq integer,
  ADD COLUMN IF NOT EXISTS plan_phase text,
  ADD COLUMN IF NOT EXISTS plan_importance text,
  ADD COLUMN IF NOT EXISTS plan_decision_refs text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS plan_deliverable text,
  ADD COLUMN IF NOT EXISTS plan_owner_gate_marker text,
  ADD COLUMN IF NOT EXISTS plan_line_text text;

COMMENT ON COLUMN harness_shared.work_items.plan_line_id IS
  'P-NNN of the plan line this row IS (one-work-graph-structured-holds-2026-10-26#D-010). Set together with plan_slug; a line node is top-level (parent_id NULL); exactly one node per (workspace_id, harness_slug, plan_slug, plan_line_id).';
COMMENT ON COLUMN harness_shared.work_items.plan_slug IS
  'Plan of the line this row IS. Distinct from source_plan_slug, which records where a work-item was stamped from and stays read-only until P-008 moves its readers.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'harness_shared.work_items'::regclass
                    AND conname = 'work_items_plan_line_pair_chk') THEN
    ALTER TABLE harness_shared.work_items
      ADD CONSTRAINT work_items_plan_line_pair_chk
      CHECK ((plan_slug IS NULL) = (plan_line_id IS NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'harness_shared.work_items'::regclass
                    AND conname = 'work_items_plan_line_top_level_chk') THEN
    ALTER TABLE harness_shared.work_items
      ADD CONSTRAINT work_items_plan_line_top_level_chk
      CHECK (plan_line_id IS NULL OR parent_id IS NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'harness_shared.work_items'::regclass
                    AND conname = 'work_items_plan_deliverable_chk') THEN
    ALTER TABLE harness_shared.work_items
      ADD CONSTRAINT work_items_plan_deliverable_chk
      CHECK (plan_deliverable IS NULL
             OR plan_deliverable = ANY (ARRAY['code','doc','decision','research','operation','artifact'])
             OR plan_deliverable ~ '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$') NOT VALID;
  END IF;
END $$;

ALTER TABLE harness_shared.work_items VALIDATE CONSTRAINT work_items_plan_line_pair_chk;
ALTER TABLE harness_shared.work_items VALIDATE CONSTRAINT work_items_plan_line_top_level_chk;
ALTER TABLE harness_shared.work_items VALIDATE CONSTRAINT work_items_plan_deliverable_chk;

CREATE UNIQUE INDEX IF NOT EXISTS work_items_plan_line_node_uniq
  ON harness_shared.work_items (workspace_id, harness_slug, plan_slug, plan_line_id)
  WHERE plan_line_id IS NOT NULL;

-- 2. Conversion findings: contradictions are recorded, never resolved silently (D-010 point 4).
CREATE TABLE IF NOT EXISTS harness_shared.plan_line_conversion_findings (
  workspace_id  text NOT NULL,
  harness_slug  text NOT NULL,
  plan_slug     text NOT NULL,
  plan_line_id  text NOT NULL,
  finding_kind  text NOT NULL CHECK (finding_kind IN (
                  'stamped-item-has-parent',
                  'blocked-line-without-edges',
                  'active-line-without-work-item',
                  'blocker-line-missing',
                  'self-blocking-line')),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, plan_slug, plan_line_id, finding_kind)
);

COMMENT ON TABLE harness_shared.plan_line_conversion_findings IS
  'Contradictions found while converting plan lines to work-item nodes (migration 1601, one-work-graph-structured-holds-2026-10-26#D-010). One row per line and kind; read by the P-009 consistency check.';

COMMENT ON COLUMN harness_shared.work_item_deps.workspace_id IS
  'Coordination workspace of the edge, not the tenant of its endpoints. Edges are written under ''default'' (migration 719 convention); endpoints are resolved by (kind, ref).';

-- 3. The conversion function. Idempotent; callable by tests and later sync code.
CREATE OR REPLACE FUNCTION harness_shared.convert_plan_lines_to_nodes(p_workspace text)
RETURNS TABLE (attached integer, created integer, children integer, edges integer, findings integer)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_attached integer := 0;
  v_created  integer := 0;
  v_children integer := 0;
  v_edges    integer := 0;
  v_findings integer := 0;
  v_n        integer := 0;
  v_now_ms   bigint  := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  c_by       constant text := 'migration:plan-line-work-item-nodes';
BEGIN
  -- 3a. Attach: a line without a node takes its earliest-created stamped work-item that has
  --     no parent and is not already another line's node.
  WITH lines AS (
    SELECT pi.*
      FROM harness_shared.plan_items pi
     WHERE pi.workspace_id = p_workspace
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.work_items n
          WHERE n.workspace_id = pi.workspace_id AND n.harness_slug = pi.harness_slug
            AND n.plan_slug = pi.plan_slug AND n.plan_line_id = pi.item_id)
  ), cand AS (
    SELECT DISTINCT ON (l.harness_slug, l.plan_slug, l.item_id)
           l.harness_slug, l.plan_slug, l.item_id, l.seq, l.phase, l.importance,
           l.decision_refs, l.deliverable, l.owner_gate_marker, l.item_text, wi.feature_id
      FROM lines l
      JOIN harness_shared.work_items wi
        ON wi.workspace_id = l.workspace_id AND wi.harness_slug = l.harness_slug
       AND wi.source_plan_slug = l.plan_slug AND l.item_id = ANY (wi.source_plan_item_ids)
     WHERE wi.parent_id IS NULL AND wi.plan_line_id IS NULL
     ORDER BY l.harness_slug, l.plan_slug, l.item_id, wi.created_ts ASC NULLS LAST, wi.feature_id
  ), uniq AS (
    SELECT DISTINCT ON (harness_slug, feature_id) *
      FROM cand
     ORDER BY harness_slug, feature_id, plan_slug, seq
  )
  UPDATE harness_shared.work_items wi
     SET plan_slug = u.plan_slug, plan_line_id = u.item_id, plan_seq = u.seq,
         plan_phase = u.phase, plan_importance = u.importance,
         plan_decision_refs = COALESCE(u.decision_refs, '{}'::text[]),
         plan_deliverable = u.deliverable, plan_owner_gate_marker = u.owner_gate_marker,
         plan_line_text = u.item_text
    FROM uniq u
   WHERE wi.workspace_id = p_workspace AND wi.harness_slug = u.harness_slug
     AND wi.feature_id = u.feature_id;
  GET DIAGNOSTICS v_attached = ROW_COUNT;

  -- 3b. Create: a line still without a node gets a new top-level feature node. An open node is
  --     parked out of self-selection until P-008 (D-011); admission stays NULL.
  WITH lines AS (
    SELECT pi.*,
           CASE pi.status WHEN 'done' THEN 'done' WHEN 'dropped' THEN 'dropped' ELSE 'open' END AS node_status
      FROM harness_shared.plan_items pi
     WHERE pi.workspace_id = p_workspace
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.work_items n
          WHERE n.workspace_id = pi.workspace_id AND n.harness_slug = pi.harness_slug
            AND n.plan_slug = pi.plan_slug AND n.plan_line_id = pi.item_id)
  )
  INSERT INTO harness_shared.work_items (
    workspace_id, harness_slug, feature_id, title, summary, status, item_kind, nature, audience,
    origin, source_plan_slug, source_plan_item_ids, feature_order, payload,
    created_ts, updated_ts, ts, closed_ts, terminal_owner, terminal_reason,
    plan_slug, plan_line_id, plan_seq, plan_phase, plan_importance, plan_decision_refs,
    plan_deliverable, plan_owner_gate_marker, plan_line_text)
  SELECT p_workspace, l.harness_slug, harness_shared.next_work_item_id(),
         left(l.item_text, 300), l.item_text, l.node_status, 'feature', 'work', 'agent',
         'local', l.plan_slug, ARRAY[l.item_id], l.seq,
         CASE WHEN l.node_status = 'open' THEN jsonb_build_object(
                '_claimHold', true,
                'claim_hold_by', c_by,
                'claim_hold_at', to_jsonb(now()),
                'claim_hold_reason',
                'Plan-line node created by migration 1601 before claimability moves onto nodes; '
                || 'lifted by one-work-graph-structured-holds-2026-10-26 P-008 (D-011).')
              ELSE '{}'::jsonb END,
         v_now_ms, v_now_ms, v_now_ms,
         CASE WHEN l.node_status IN ('done','dropped') THEN v_now_ms END,
         CASE WHEN l.node_status IN ('done','dropped') THEN c_by END,
         CASE WHEN l.node_status IN ('done','dropped')
              THEN 'plan line was ' || l.status || ' before conversion to a work-item node' END,
         l.plan_slug, l.item_id, l.seq, l.phase, l.importance, COALESCE(l.decision_refs, '{}'::text[]),
         l.deliverable, l.owner_gate_marker, l.item_text
    FROM lines l
   ORDER BY l.harness_slug, l.plan_slug, l.seq;
  GET DIAGNOSTICS v_created = ROW_COUNT;

  -- 3c. Children: the line's other stamped work-items (no parent yet) hang under its node.
  UPDATE harness_shared.work_items c
     SET parent_id = n.feature_id
    FROM harness_shared.work_items n
   WHERE n.workspace_id = p_workspace AND n.plan_line_id IS NOT NULL
     AND c.workspace_id = n.workspace_id AND c.harness_slug = n.harness_slug
     AND c.source_plan_slug = n.plan_slug AND n.plan_line_id = ANY (c.source_plan_item_ids)
     AND c.feature_id <> n.feature_id
     AND c.parent_id IS NULL AND c.plan_line_id IS NULL;
  GET DIAGNOSTICS v_children = ROW_COUNT;

  -- 3d. Edges: every blocked_by entry between two lines of the same plan.
  INSERT INTO harness_shared.work_item_deps (
    workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction, created_by)
  SELECT 'default',
         CASE WHEN n.item_kind IN ('bug','change','task','cleanup') THEN 'issue' ELSE 'feature' END,
         CASE WHEN n.item_kind IN ('bug','change','task','cleanup') THEN n.feature_id
              ELSE n.harness_slug || '#' || n.feature_id END,
         CASE WHEN b.item_kind IN ('bug','change','task','cleanup') THEN 'issue' ELSE 'feature' END,
         CASE WHEN b.item_kind IN ('bug','change','task','cleanup') THEN b.feature_id
              ELSE b.harness_slug || '#' || b.feature_id END,
         'blocks', 'settled', c_by
    FROM harness_shared.plan_items pi
    CROSS JOIN LATERAL unnest(pi.blocked_by) AS bb(ref)
    JOIN harness_shared.work_items n
      ON n.workspace_id = pi.workspace_id AND n.harness_slug = pi.harness_slug
     AND n.plan_slug = pi.plan_slug AND n.plan_line_id = pi.item_id
    JOIN harness_shared.work_items b
      ON b.workspace_id = pi.workspace_id AND b.harness_slug = pi.harness_slug
     AND b.plan_slug = pi.plan_slug AND b.plan_line_id = btrim(bb.ref)
   WHERE pi.workspace_id = p_workspace
     AND btrim(bb.ref) <> pi.item_id
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_edges = ROW_COUNT;

  -- 3e. Findings (one row per line and kind; refreshed on re-run).
  INSERT INTO harness_shared.plan_line_conversion_findings
    (workspace_id, harness_slug, plan_slug, plan_line_id, finding_kind, detail)
  SELECT n.workspace_id, n.harness_slug, n.plan_slug, n.plan_line_id, 'stamped-item-has-parent',
         jsonb_build_object('node', n.feature_id,
           'items', jsonb_agg(jsonb_build_object('featureId', c.feature_id, 'parentId', c.parent_id)
                              ORDER BY c.feature_id))
    FROM harness_shared.work_items n
    JOIN harness_shared.work_items c
      ON c.workspace_id = n.workspace_id AND c.harness_slug = n.harness_slug
     AND c.source_plan_slug = n.plan_slug AND n.plan_line_id = ANY (c.source_plan_item_ids)
   WHERE n.workspace_id = p_workspace AND n.plan_line_id IS NOT NULL
     AND c.feature_id <> n.feature_id AND c.plan_line_id IS NULL
     AND c.parent_id IS NOT NULL AND c.parent_id <> n.feature_id
   GROUP BY n.workspace_id, n.harness_slug, n.plan_slug, n.plan_line_id, n.feature_id
  ON CONFLICT (workspace_id, harness_slug, plan_slug, plan_line_id, finding_kind)
  DO UPDATE SET detail = EXCLUDED.detail, recorded_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT; v_findings := v_findings + v_n;

  INSERT INTO harness_shared.plan_line_conversion_findings
    (workspace_id, harness_slug, plan_slug, plan_line_id, finding_kind, detail)
  SELECT pi.workspace_id, pi.harness_slug, pi.plan_slug, pi.item_id, 'blocked-line-without-edges',
         jsonb_build_object('lineStatus', pi.status)
    FROM harness_shared.plan_items pi
   WHERE pi.workspace_id = p_workspace AND pi.status = 'blocked'
     AND COALESCE(cardinality(pi.blocked_by), 0) = 0
  ON CONFLICT (workspace_id, harness_slug, plan_slug, plan_line_id, finding_kind)
  DO UPDATE SET detail = EXCLUDED.detail, recorded_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT; v_findings := v_findings + v_n;

  INSERT INTO harness_shared.plan_line_conversion_findings
    (workspace_id, harness_slug, plan_slug, plan_line_id, finding_kind, detail)
  SELECT pi.workspace_id, pi.harness_slug, pi.plan_slug, pi.item_id, 'active-line-without-work-item',
         jsonb_build_object('lineStatus', pi.status, 'node', n.feature_id)
    FROM harness_shared.plan_items pi
    JOIN harness_shared.work_items n
      ON n.workspace_id = pi.workspace_id AND n.harness_slug = pi.harness_slug
     AND n.plan_slug = pi.plan_slug AND n.plan_line_id = pi.item_id
   WHERE pi.workspace_id = p_workspace AND pi.status IN ('wip','needs-human')
     AND (n.payload ->> 'claim_hold_by') = c_by
  ON CONFLICT (workspace_id, harness_slug, plan_slug, plan_line_id, finding_kind)
  DO UPDATE SET detail = EXCLUDED.detail, recorded_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT; v_findings := v_findings + v_n;

  INSERT INTO harness_shared.plan_line_conversion_findings
    (workspace_id, harness_slug, plan_slug, plan_line_id, finding_kind, detail)
  SELECT pi.workspace_id, pi.harness_slug, pi.plan_slug, pi.item_id,
         CASE WHEN bool_or(btrim(bb.ref) = pi.item_id) THEN 'self-blocking-line' ELSE 'blocker-line-missing' END,
         jsonb_build_object('refs', jsonb_agg(btrim(bb.ref) ORDER BY btrim(bb.ref)))
    FROM harness_shared.plan_items pi
    CROSS JOIN LATERAL unnest(pi.blocked_by) AS bb(ref)
   WHERE pi.workspace_id = p_workspace
     AND (btrim(bb.ref) = pi.item_id
          OR NOT EXISTS (
            SELECT 1 FROM harness_shared.plan_items b
             WHERE b.workspace_id = pi.workspace_id AND b.harness_slug = pi.harness_slug
               AND b.plan_slug = pi.plan_slug AND b.item_id = btrim(bb.ref)))
   GROUP BY pi.workspace_id, pi.harness_slug, pi.plan_slug, pi.item_id
  ON CONFLICT (workspace_id, harness_slug, plan_slug, plan_line_id, finding_kind)
  DO UPDATE SET detail = EXCLUDED.detail, recorded_at = now();
  GET DIAGNOSTICS v_n = ROW_COUNT; v_findings := v_findings + v_n;

  RETURN QUERY SELECT v_attached, v_created, v_children, v_edges, v_findings;
END;
$fn$;

COMMENT ON FUNCTION harness_shared.convert_plan_lines_to_nodes(text) IS
  'Idempotent plan-line -> work-item node conversion (migration 1601, one-work-graph-structured-holds-2026-10-26#D-010/#D-011). Returns counts of attached, created, re-parented children, edges written and findings recorded.';

-- 4. Convert every workspace that has plan lines.
SELECT w.workspace_id, c.*
  FROM (SELECT DISTINCT workspace_id FROM harness_shared.plan_items) w
  CROSS JOIN LATERAL harness_shared.convert_plan_lines_to_nodes(w.workspace_id) c;
