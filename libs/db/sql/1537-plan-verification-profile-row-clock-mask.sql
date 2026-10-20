-- 1537-plan-verification-profile-row-clock-mask.sql
--
-- plan-verification-profiles-2026-10-17 P-002 (WI-6554700010017301), requirement R-6.
--
-- WHY
--   Migration 1536 added harness_plans.verification_profile and
--   verification_profile_source. They are LOCAL machine state (like the plan's
--   acceptance-bar stamps): no plan wire row carries them, so a write to them can
--   never emit a federation op. But the BEFORE trigger stamp_local_federated_write
--   counted every column outside its mask as row CONTENT. A profile-only UPDATE
--   therefore re-stamped the row as a fresh LOCAL write: new fed_ts / fed_hlc and
--   origin='local'. Measured before this migration (2026-10-20): 183 of 2,559
--   plans on this box have origin='remote', and the R-6 backfill writes the
--   profile on every one of them. Each would have flipped to origin='local' with a
--   local clock newer than the publisher's last op and no wire op behind it, so a
--   later publisher edit could lose last-writer-wins to a write that never shipped.
--
-- WHAT CHANGES
--   For harness_plans only, verification_profile and verification_profile_source
--   join the bookkeeping mask, beside the 1481 Now-note columns. A profile-only
--   UPDATE keeps the row clock and origin. The plans:new stamp runs inside the
--   creating transaction, so a new plan's clock is the INSERT's either way. The
--   rest of the body is copied verbatim from the live definition (last changed by
--   1481-plan-now-note-row-clock-mask.sql).
--
-- Additive in effect (CREATE OR REPLACE FUNCTION, no DDL on any table): the
-- currently-deployed release never writes the profile columns, so its behaviour
-- is unchanged.

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
    -- 1537 (plan-verification-profiles-2026-10-17 P-002, R-6): the verification
    -- profile and its source are local machine state that no wire row carries, so a
    -- profile-only write (the backfill) keeps the row clock and origin too.
    IF TG_TABLE_NAME = 'harness_plans' THEN
      mask := mask || ARRAY[
        'now_note', 'now_state', 'now_next',
        'verification_profile', 'verification_profile_source'
      ];
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
