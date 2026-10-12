-- 1481-plan-now-note-row-clock-mask.sql
--
-- derived-status-not-hand-written-2026-10-12 P-004 (WI-6554700010009033), decision D-009.
--
-- WHY
--   A plan's Now note (harness_plans.now_note, migration 1480) carries its own
--   last-writer-wins clock: now_note.writtenAt (D-008). The BEFORE trigger
--   stamp_local_federated_write counted the note and its now_state / now_next
--   projection as row CONTENT. So a peer note applied with an op clock that
--   does not advance the row clock was re-stamped as a fresh LOCAL write
--   (new fed_ts / fed_hlc, origin='local'). Measured in
--   now-note-store.integration.test.ts: fed_ts moved from 1791847649163 to
--   1791847649415 after an apply whose op clock was older than the row's. The
--   commonest case is a first arrival under per-part federation: the
--   bootstrap INSERT takes the op's clock, then the note apply runs with that
--   same clock.
--
-- WHAT CHANGES
--   For harness_plans only, now_note / now_state / now_next join the
--   bookkeeping mask, so a note-only UPDATE keeps the row clock and origin.
--   A local note write (writePlanNowNote) stamps a fresh clock explicitly, so
--   it still federates with an advanced op clock, exactly as before. The rest
--   of the body is copied verbatim from the live definition (last changed by
--   1226-feature-wire-row-drives-stamp-clock.sql).
--
-- Additive in effect (CREATE OR REPLACE FUNCTION, no DDL on any table): the
-- currently-deployed release never writes now_note, so its behaviour is unchanged.

CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  mask text[] := ARRAY[
    'fed_ts', 'fed_hlc', 'origin', 'author_pubkey', 'updated_at',
    '_search', 'version', 'local_disposition'
  ];
  gen_cols text[];
  content_changed boolean;
  wire_clock_keys text[] := ARRAY['fed_ts', 'fed_hlc', 'origin', 'author_pubkey'];
  -- WI-10002882: a feature wire row also carries ts/updated_ts, which the generic mask
  -- has always treated as bookkeeping for work_items. They are not content.
  feature_non_content_keys text[] := ARRAY['fed_ts', 'fed_hlc', 'origin', 'author_pubkey', 'ts', 'updated_ts'];
BEGIN
  -- A write that moves either component of the wire order key is a projection
  -- apply or an explicit repair/backfill. Respect it verbatim and advance the PG
  -- HLC clock so a later legitimate local write is causally after it.
  IF TG_OP = 'UPDATE'
     AND (NEW.fed_ts IS DISTINCT FROM OLD.fed_ts
          OR NEW.fed_hlc IS DISTINCT FROM OLD.fed_hlc) THEN
    IF NEW.fed_hlc IS NOT NULL THEN
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A projection INSERT carries the op's fed_ts AND origin='remote'; a local
    -- INSERT carries neither. Gate the stamp on origin so a remote ts-less op
    -- cannot receive a fresh local clock and pass the projection's LWW guard.
    IF NEW.fed_ts IS NULL AND COALESCE(NEW.origin, 'local') = 'local' THEN
      NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      NEW.fed_hlc := harness_shared.hlc_now();
    ELSIF NEW.fed_hlc IS NOT NULL THEN
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE with the wire clock untouched is a local write or a same-op re-fold.
  -- Stamp only when a real content column changed. Bookkeeping and generated
  -- columns retain their prior clock and origin.
  -- This function serves ~22 tables. PL/pgSQL resolves a record field reference
  -- (OLD.item_kind) when the statement runs, NOT lazily inside a short-circuited AND,
  -- so the work_items-only fields must sit behind a NESTED IF on the table name.
  content_changed := NULL;
  IF TG_TABLE_NAME = 'work_items' THEN
    IF OLD.item_kind IN ('bug', 'change', 'task')
       AND NEW.item_kind IN ('bug', 'change', 'task') THEN
      -- WI-10002875: for an issue-family row, "content" is exactly what ships — the
      -- engineer-issues wire row (shared with capture_work_items_outbox) minus its
      -- clock/provenance keys. A write to a local-only column (embeddings, release
      -- and attempt bookkeeping, ...) keeps the clock, so it emits no wire op.
      -- `lane` (which the capture triggers gate on) is GENERATED as payload->>'lane'
      -- and payload is on the wire, so a promoted observation still stamps. Do not
      -- read NEW.lane here: generated columns are computed AFTER BEFORE triggers.
      content_changed :=
        (harness_shared.engineer_issue_wire_row(NEW, NEW.workspace_id, NULL, NULL) - wire_clock_keys)
          IS DISTINCT FROM
        (harness_shared.engineer_issue_wire_row(OLD, OLD.workspace_id, NULL, NULL) - wire_clock_keys);
    ELSIF COALESCE(OLD.item_kind, '') NOT IN ('bug', 'change', 'task')
          AND COALESCE(NEW.item_kind, '') NOT IN ('bug', 'change', 'task') THEN
      -- WI-10002882: for a feature-family row, "content" is exactly what a peer
      -- APPLIES — feature_wire_row (shared with capture_work_items_outbox) minus its
      -- clock/provenance and ts/updated_ts bookkeeping keys. A write to a local-only
      -- column (embeddings, verifier/audit/rank/schedule bookkeeping, release history,
      -- ...) keeps the clock and origin, so it can no longer mint a wire version — the
      -- write that let two peers re-stamp one row back and forth forever (WI-10003230).
      content_changed :=
        (harness_shared.feature_wire_row(NEW) - feature_non_content_keys)
          IS DISTINCT FROM
        (harness_shared.feature_wire_row(OLD) - feature_non_content_keys);
    END IF;
  END IF;

  IF content_changed IS NULL THEN
    IF TG_TABLE_NAME = 'work_items' THEN
      mask := mask || ARRAY['updated_ts', 'ts'];
    END IF;
    -- 1481 (derived-status-not-hand-written-2026-10-12 P-004, D-009): a plan's Now note
    -- carries its own last-writer-wins clock (now_note.writtenAt), so the note and its
    -- now_state/now_next projection are not row content for the row clock. A peer
    -- note apply therefore keeps the row clock and origin instead of re-stamping the
    -- row as a fresh local write. A local note write stamps its clock explicitly.
    IF TG_TABLE_NAME = 'harness_plans' THEN
      mask := mask || ARRAY['now_note', 'now_state', 'now_next'];
    END IF;

    SELECT coalesce(array_agg(a.attname::text), ARRAY[]::text[])
      INTO gen_cols
      FROM pg_attribute a
     WHERE a.attrelid = TG_RELID
       AND a.attgenerated <> ''
       AND a.attnum > 0
       AND NOT a.attisdropped;
    mask := mask || gen_cols;

    content_changed := (to_jsonb(NEW) - mask) IS DISTINCT FROM (to_jsonb(OLD) - mask);
  END IF;

  -- WI-6250: this host is a receiver, not the publisher, when a signed row's
  -- current provenance is remote. A clock-stationary content mutation therefore
  -- cannot be authorized or re-signed here. Fail loudly before an unsigned local
  -- replacement can mint a newer LWW clock and permanently shadow the publisher.
  IF content_changed
     AND COALESCE(OLD.origin, 'local') = 'remote'
     AND NULLIF(to_jsonb(OLD)->>'signer_device_pubkey', '') IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'publisher-signed remote row on %I.%I cannot be changed by a local write',
        TG_TABLE_SCHEMA,
        TG_TABLE_NAME
      ),
      DETAIL = 'Move fed_ts or fed_hlc only when applying an authenticated projection op or an explicit repair.';
  END IF;

  IF content_changed THEN
    NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    NEW.fed_hlc := harness_shared.hlc_now();
    NEW.origin := 'local';
  END IF;
  RETURN NEW;
END;
$function$;
