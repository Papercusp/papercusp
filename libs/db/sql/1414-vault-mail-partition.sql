-- 1414: the Personal Vault's mail partition is provider-neutral — `gmail` -> `mail`
-- (WI-10006490; residue of plan
--  generalized-integrations-google-migration-cupboard-workflows-2026-10-05,
--  P-006 / D-023 point 7).
--
-- Vault routing has been DATATYPE-keyed since D-010 (1357): every provider's
-- `email-message` lands in ONE Vault partition and is read under ONE scope. That
-- partition was still named for Google — documents.source = 'gmail', so its
-- GENERATED scope_key was `personal:gmail` — which gated an Outlook-shaped
-- source's mail behind a Gmail-named grant. This renames the partition to
-- `mail` (scope `personal:mail`) everywhere the Vault stores the name:
--
--   documents.source + the `gmail:` segment of dedupe_key   (scope_key follows source)
--   personal_grants.scopes            personal:gmail -> personal:mail
--   personal_sync_state.source        gmail -> mail
--   personal_identity_aliases.source  gmail -> mail
--
-- data_sources.kind = 'gmail' names the Gmail PROVIDER, not the partition, and
-- is untouched. Calendar was already neutral ('calendar' / personal:calendar).
--
-- Data rewrite + new functions/triggers only: no DROP or RENAME of any object,
-- no SET NOT NULL, no index change.
--
-- EXPAND WINDOW. This applies to the shared database as soon as an operator
-- built from staging boots, while :3070 still runs the previous release for as
-- long as the green gate holds main. That release WRITES the legacy names
-- (source 'gmail', dedupe keys `[account:<sha256>:]gmail:…`, grants carrying
-- personal:gmail). Left alone, each such write would mint a `gmail` twin beside
-- its renamed row. The BEFORE triggers below rewrite those writes on the way
-- in; PostgreSQL fires BEFORE ROW INSERT triggers before ON CONFLICT
-- arbitration, so a legacy-shaped upsert conflicts with the renamed row instead
-- of duplicating it. Triggers on one table fire in name order, so on documents
-- 1357's documents_normalize_legacy_routing (datatype stamp + source-scoped
-- key) runs before documents_normalize_mail_partition. The previous release's
-- READS under 'gmail' / personal:gmail find nothing until it is replaced;
-- measured over the 7 days before this migration: 5 personal:search calls and
-- 0 mail verb calls were served by :3070. The triggers are a no-op for the new
-- code and are dropped by a contract migration tracked on WI-10006996.

-- ── documents ──────────────────────────────────────────────────────────────
-- A `mail` twin can only exist if new code ingested a message before this
-- migration ran; the twin is the newer write, so the legacy row goes.
DELETE FROM harness_shared.documents g
 USING harness_shared.documents m
 WHERE g.source = 'gmail'
   AND m.source = 'mail'
   AND m.workspace_id = g.workspace_id
   AND m.user_id = g.user_id
   AND m.dedupe_key = regexp_replace(g.dedupe_key, '^(account:[0-9a-f]{64}:)?gmail:', '\1mail:');

UPDATE harness_shared.documents
   SET source = 'mail',
       dedupe_key = regexp_replace(dedupe_key, '^(account:[0-9a-f]{64}:)?gmail:', '\1mail:')
 WHERE source = 'gmail';

-- ── personal_sync_state ────────────────────────────────────────────────────
DELETE FROM harness_shared.personal_sync_state g
 USING harness_shared.personal_sync_state m
 WHERE g.source = 'gmail'
   AND m.source = 'mail'
   AND m.workspace_id = g.workspace_id
   AND m.user_id = g.user_id;

UPDATE harness_shared.personal_sync_state
   SET source = 'mail', updated_at = now()
 WHERE source = 'gmail';

-- ── personal_identity_aliases ──────────────────────────────────────────────
-- An alias row records where an address was seen; a `mail` twin carries the
-- same identity link, so the legacy row is redundant.
DELETE FROM harness_shared.personal_identity_aliases g
 USING harness_shared.personal_identity_aliases m
 WHERE g.source = 'gmail'
   AND m.source = 'mail'
   AND m.workspace_id = g.workspace_id
   AND m.user_id = g.user_id
   AND m.alias_kind = g.alias_kind
   AND m.normalized_value = g.normalized_value;

UPDATE harness_shared.personal_identity_aliases
   SET source = 'mail'
 WHERE source = 'gmail';

-- ── personal_grants ────────────────────────────────────────────────────────
-- Scopes are rewritten to a sorted, de-duplicated set (the shape the grant
-- writer stores). A live grant is unique per (principal, scopes), so when two
-- live grants of one principal converge on the same rewritten set, keep one —
-- an already-neutral grant first, else the oldest — and revoke the rest. The
-- revocation is historical (revoked_at), never a delete.
CREATE OR REPLACE FUNCTION harness_shared.personal_mail_partition_scopes(scopes text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT ARRAY(
    SELECT DISTINCT s
      FROM unnest(array_replace(scopes, 'personal:gmail', 'personal:mail')) AS s
     ORDER BY s
  )
$fn$;

COMMENT ON FUNCTION harness_shared.personal_mail_partition_scopes(text[]) IS
  'TRANSITIONAL (1414, WI-10006490): personal:gmail -> personal:mail, returned sorted and de-duplicated. Drop with the 1414 triggers (WI-10006996).';

WITH live AS (
  SELECT g.workspace_id, g.user_id, g.id,
         ('personal:gmail' = ANY (g.scopes)) AS legacy,
         row_number() OVER (
           PARTITION BY g.workspace_id, g.user_id, g.principal_type, g.principal_id,
                        harness_shared.personal_mail_partition_scopes(g.scopes)
           ORDER BY ('personal:gmail' = ANY (g.scopes)), g.granted_at, g.id
         ) AS rn
    FROM harness_shared.personal_grants g
   WHERE g.revoked_at IS NULL
)
UPDATE harness_shared.personal_grants g
   SET revoked_at = now(),
       metadata = g.metadata || jsonb_build_object(
         'revokedBy', '1414-vault-mail-partition',
         'revokedReason', 'duplicate of a live grant once personal:gmail became personal:mail')
  FROM live
 WHERE g.workspace_id = live.workspace_id
   AND g.user_id = live.user_id
   AND g.id = live.id
   AND live.legacy
   AND live.rn > 1;

UPDATE harness_shared.personal_grants
   SET scopes = harness_shared.personal_mail_partition_scopes(scopes)
 WHERE 'personal:gmail' = ANY (scopes);

-- ── transitional legacy-write normalizers (see EXPAND WINDOW) ─────────────
CREATE OR REPLACE FUNCTION harness_shared.documents_normalize_mail_partition()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.source = 'gmail' THEN
    NEW.source := 'mail';
    NEW.dedupe_key := regexp_replace(NEW.dedupe_key, '^(account:[0-9a-f]{64}:)?gmail:', '\1mail:');
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION harness_shared.documents_normalize_mail_partition() IS
  'TRANSITIONAL (1414, WI-10006490): rewrites a legacy gmail-partition Vault write into the mail partition. Drop once no deployed release writes source gmail (WI-10006996).';

DROP TRIGGER IF EXISTS documents_normalize_mail_partition ON harness_shared.documents;
CREATE TRIGGER documents_normalize_mail_partition
  BEFORE INSERT OR UPDATE OF source, dedupe_key ON harness_shared.documents
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.documents_normalize_mail_partition();

CREATE OR REPLACE FUNCTION harness_shared.personal_source_normalize_mail_partition()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.source = 'gmail' THEN
    NEW.source := 'mail';
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION harness_shared.personal_source_normalize_mail_partition() IS
  'TRANSITIONAL (1414, WI-10006490): gmail -> mail on a legacy Vault sync-state or identity-alias write. Drop with the other 1414 triggers (WI-10006996).';

DROP TRIGGER IF EXISTS personal_sync_state_normalize_mail_partition ON harness_shared.personal_sync_state;
CREATE TRIGGER personal_sync_state_normalize_mail_partition
  BEFORE INSERT OR UPDATE OF source ON harness_shared.personal_sync_state
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.personal_source_normalize_mail_partition();

DROP TRIGGER IF EXISTS personal_identity_aliases_normalize_mail_partition ON harness_shared.personal_identity_aliases;
CREATE TRIGGER personal_identity_aliases_normalize_mail_partition
  BEFORE INSERT OR UPDATE OF source ON harness_shared.personal_identity_aliases
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.personal_source_normalize_mail_partition();

CREATE OR REPLACE FUNCTION harness_shared.personal_grants_normalize_mail_partition()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF 'personal:gmail' = ANY (NEW.scopes) THEN
    NEW.scopes := harness_shared.personal_mail_partition_scopes(NEW.scopes);
  END IF;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION harness_shared.personal_grants_normalize_mail_partition() IS
  'TRANSITIONAL (1414, WI-10006490): rewrites personal:gmail in a legacy grant write to personal:mail. Drop once no deployed release grants personal:gmail (WI-10006996).';

DROP TRIGGER IF EXISTS personal_grants_normalize_mail_partition ON harness_shared.personal_grants;
CREATE TRIGGER personal_grants_normalize_mail_partition
  BEFORE INSERT OR UPDATE OF scopes ON harness_shared.personal_grants
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.personal_grants_normalize_mail_partition();
