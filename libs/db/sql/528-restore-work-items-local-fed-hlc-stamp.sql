-- 528-restore-work-items-local-fed-hlc-stamp.sql
--
-- EI-8212: restore the D-001 local-write HLC invariant after migration 517.
--
-- Migration 517 correctly fixed the work_items-specific content mask by excluding
-- updated_ts/ts from the local-write diff, but its CREATE OR REPLACE body regressed
-- migration 314's HLC behavior:
--   * local INSERTs stamped fed_ts only, leaving fed_hlc NULL;
--   * remote applies carrying fed_hlc no longer advanced the PG HLC clock.
--
-- That re-opened the D-001 local-vs-remote split-brain surface: a direct local
-- feature/work-item write could be ordered by wall-clock fed_ts instead of the
-- write-time HLC. Keep 517's table-scoped work_items mask, but restore 314's
-- fed_hlc stamping and recv-advance behavior.

CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write() RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
BEGIN
  -- A write that moves fed_ts is a projection apply (remote op; fed_ts = the
  -- op's wire ts) or an explicit repair/backfill. Respect it verbatim, but if
  -- the apply carried an HLC, recv-advance the PG HLC clock so the next local
  -- write causally follows it.
  IF TG_OP = 'UPDATE' AND NEW.fed_ts IS DISTINCT FROM OLD.fed_ts THEN
    IF NEW.fed_hlc IS NOT NULL THEN
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A projection INSERT carries the op's fed_ts AND origin='remote'; a local
    -- INSERT carries neither. Local inserts must stamp BOTH clocks atomically:
    -- fed_ts for legacy fallback and fed_hlc for the D-001 ordering key.
    IF NEW.fed_ts IS NULL AND COALESCE(NEW.origin, 'local') = 'local' THEN
      NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      NEW.fed_hlc := harness_shared.hlc_now();
    ELSIF NEW.fed_hlc IS NOT NULL THEN
      PERFORM harness_shared.hlc_recv(NEW.fed_hlc);
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE with fed_ts untouched = a local write (or a same-op re-fold). Stamp
  -- only on real content changes. The work_items table was renamed from
  -- harness_features_consolidated in migration 374 and uses updated_ts/ts as
  -- bookkeeping columns; mask those only for that table, preserving 517's fix.
  IF TG_TABLE_NAME = 'work_items' THEN
    IF (to_jsonb(NEW) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition' - 'updated_ts' - 'ts')
       IS DISTINCT FROM
       (to_jsonb(OLD) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition' - 'updated_ts' - 'ts')
    THEN
      NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
      NEW.fed_hlc := harness_shared.hlc_now();
      NEW.origin := 'local';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition')
  THEN
    NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    NEW.fed_hlc := harness_shared.hlc_now();
    NEW.origin := 'local';
  END IF;
  RETURN NEW;
END;
$fn$;
