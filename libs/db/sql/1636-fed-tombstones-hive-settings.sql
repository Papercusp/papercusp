-- 1636: federated delete tombstones (WI-6554700010049343, plan p2p-v1-core-release-2026-11-13 R-3).
--
-- A federated delete used to remove the row and leave nothing behind. A put that is OLDER
-- than the delete but is applied AFTER it (a log downloaded later, a re-fold after restart)
-- then found no row, passed the put guard, and brought the row back on that peer only.
-- This table keeps the delete's order key so the put guard can lose to it.
--
-- Opt-in per table: the capture trigger records a tombstone only when its trigger passes
-- 'tombstone' as its second argument, and only that table's projection reads it. v1 opts in
-- harness_shared.pot_settings (the hive-settings-by-key projection).
--
-- Additive only: a new table, a CREATE OR REPLACE of capture_substrate_outbox whose
-- behaviour is unchanged for every trigger that passes one argument, and the pot_settings
-- capture trigger recreated with the extra argument.

CREATE TABLE IF NOT EXISTS harness_shared.fed_tombstones (
  workspace_id TEXT NOT NULL,
  harness_slug TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  row_key      TEXT NOT NULL,
  fed_hlc      TEXT,
  fed_ts       BIGINT,
  deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, table_name, row_key)
);

COMMENT ON TABLE harness_shared.fed_tombstones IS
  'Order key (fed_hlc, fed_ts) of the newest federated delete per row, so an older put applied after the delete cannot resurrect the row. Written by capture_substrate_outbox for opted-in tables (trigger arg 2 = tombstone) and by those tables'' projections on an inbound delete; a winning newer put clears it.';

CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox() RETURNS trigger
LANGUAGE plpgsql AS $function$
DECLARE
  v_op TEXT;
  v_rec RECORD;
  v_origin TEXT;
  v_key TEXT;
  v_row JSONB;
  v_ws TEXT;
  v_slug TEXT;
  v_op_hlc TEXT;
  v_ts BIGINT;
  v_keycol TEXT := TG_ARGV[0];
BEGIN
  IF (TG_OP = 'DELETE') THEN v_op := 'del'; v_rec := OLD; ELSE v_op := 'put'; v_rec := NEW; END IF;
  v_row := to_jsonb(v_rec);
  v_origin := v_row ->> 'origin';
  -- Echo-loop guard: skip remote-origin writes (the projection's own writes).
  IF COALESCE(v_origin, 'local') <> 'local' THEN RETURN v_rec; END IF;
  v_key := v_row ->> v_keycol;
  v_ws := COALESCE(v_row ->> 'workspace_id', '');
  -- C1/P-009 (mig 359): canonicalize the federation routing key so a retired
  -- slug (papercup) self-heals into its current hive.
  v_slug := harness_shared.canonical_harness_slug(v_row ->> 'harness_slug');
  -- D-001 / mig 446: put → the row's fed_hlc and fed_ts (the BEFORE stamp trigger's
  -- values); del → a fresh hlc_now() and now() (the del event's own clock).
  IF v_op = 'del' THEN
    v_op_hlc := harness_shared.hlc_now();
    v_ts := (extract(epoch from now()) * 1000)::bigint;
  ELSE
    v_op_hlc := v_row ->> 'fed_hlc';
    v_ts := CASE WHEN v_op_hlc IS NOT NULL
      THEN COALESCE((v_row ->> 'fed_ts')::bigint, (extract(epoch from now()) * 1000)::bigint)
      ELSE (extract(epoch from now()) * 1000)::bigint END;
  END IF;
  INSERT INTO harness_shared.substrate_outbox
    (workspace_id, harness_slug, table_name, op, key, row, ts, op_hlc)
  VALUES (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row, v_ts, v_op_hlc);
  -- 1636: an opted-in table keeps the local delete's order key, identical to the del op's,
  -- so a put older than this delete arriving later from another log cannot resurrect the row.
  IF v_op = 'del' AND TG_NARGS > 1 AND TG_ARGV[1] = 'tombstone' THEN
    INSERT INTO harness_shared.fed_tombstones AS t
      (workspace_id, harness_slug, table_name, row_key, fed_hlc, fed_ts)
    VALUES (COALESCE(v_row ->> 'workspace_id', ''), v_row ->> 'harness_slug', TG_TABLE_NAME, v_key, v_op_hlc, v_ts)
    ON CONFLICT (workspace_id, harness_slug, table_name, row_key) DO UPDATE SET
      fed_hlc = EXCLUDED.fed_hlc, fed_ts = EXCLUDED.fed_ts, deleted_at = now()
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts)
        > harness_shared.fed_order_key(t.fed_hlc, t.fed_ts);
  END IF;
  PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);
  RETURN v_rec;
END;
$function$;

-- Only the INSERT OR DELETE trigger can see a delete; the UPDATE trigger keeps one argument.
DROP TRIGGER IF EXISTS capture_pot_settings_outbox_trg ON harness_shared.pot_settings;
CREATE TRIGGER capture_pot_settings_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.pot_settings
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('setting_key', 'tombstone');
