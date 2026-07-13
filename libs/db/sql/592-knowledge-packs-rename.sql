-- 592 — learning packs → knowledge packs: storage + stored-config rename.
-- (cupboard-public-release-2026-07-12 P-001 / knowledge-packs-2026-07-11 D-001.)
--
-- D-001 is a HARD rename with NO read-time aliases: the code now speaks
-- `knowledge_pack_candidates`, `knowledge-packs:disabled` and
-- `papercusp-knowledge-packs` exclusively. Anything still stored under an old
-- name is therefore INVISIBLE to the new code — a silently-dropped mute setting
-- or a silently-ignored flag override is exactly the "stored-override migration,
-- not aliased" the plan calls for (P-003). This migration moves the stored state
-- so the hard rename is safe.
--
-- Three stores, three shapes:
--   1. TABLE  harness_shared.learning_pack_candidates (+ 6 constraint/index names)
--   2. ROW    harness_shared.pot_settings.setting_key = 'learning-packs:disabled'
--   3. JSONB  harness_shared.operator_flag_overrides.payload -> 'papercusp-learning-packs'
--
-- Fully idempotent (IF EXISTS / conditional guards) — safe to re-run, and a
-- no-op on a fresh database that never had the old names.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The candidates table + every dependent object name.
--
-- Postgres does NOT rename constraints/indexes when you rename their table, so
-- each is renamed explicitly. candidates.ts pins one of them BY NAME in an
-- `ON CONFLICT ON CONSTRAINT knowledge_pack_candidates_signature_uniq` clause —
-- miss that rename and every candidate INSERT throws at runtime.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'harness_shared' AND table_name = 'learning_pack_candidates'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'harness_shared' AND table_name = 'knowledge_pack_candidates'
  ) THEN
    ALTER TABLE harness_shared.learning_pack_candidates
      RENAME TO knowledge_pack_candidates;
  END IF;
END $$;

ALTER TABLE IF EXISTS harness_shared.knowledge_pack_candidates
  RENAME CONSTRAINT learning_pack_candidates_pkey TO knowledge_pack_candidates_pkey;
ALTER TABLE IF EXISTS harness_shared.knowledge_pack_candidates
  RENAME CONSTRAINT learning_pack_candidates_workspace_nonempty TO knowledge_pack_candidates_workspace_nonempty;
ALTER TABLE IF EXISTS harness_shared.knowledge_pack_candidates
  RENAME CONSTRAINT learning_pack_candidates_kind_check TO knowledge_pack_candidates_kind_check;
ALTER TABLE IF EXISTS harness_shared.knowledge_pack_candidates
  RENAME CONSTRAINT learning_pack_candidates_status_check TO knowledge_pack_candidates_status_check;
ALTER TABLE IF EXISTS harness_shared.knowledge_pack_candidates
  RENAME CONSTRAINT learning_pack_candidates_signature_uniq TO knowledge_pack_candidates_signature_uniq;

ALTER INDEX IF EXISTS harness_shared.learning_pack_candidates_listing_idx
  RENAME TO knowledge_pack_candidates_listing_idx;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The per-pot pack-mute setting key.
--
-- ON CONFLICT DO NOTHING + a delete of the leftover: a pot could (pathologically)
-- already hold BOTH keys if something wrote the new one before this ran. The new
-- key wins; the stale row is dropped rather than clobbering it.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE harness_shared.pot_settings AS old
   SET setting_key = 'knowledge-packs:disabled'
 WHERE old.setting_key = 'learning-packs:disabled'
   AND NOT EXISTS (
     SELECT 1 FROM harness_shared.pot_settings AS new_row
      WHERE new_row.workspace_id = old.workspace_id
        AND new_row.harness_slug = old.harness_slug
        AND new_row.setting_key  = 'knowledge-packs:disabled'
   );

DELETE FROM harness_shared.pot_settings
 WHERE setting_key = 'learning-packs:disabled';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The feature-flag override key, which lives INSIDE a JSONB payload
--    (operator_flag_overrides is keyed by workspace_id; each flag is a key in
--    `payload`). Re-key the entry, preserving its value, only where the old key
--    exists and the new one does not.
--
--    This one is load-bearing: FLAGS.KNOWLEDGE_PACKS now resolves
--    'papercusp-knowledge-packs'. A workspace that had deliberately turned packs
--    OFF via an override row would, without this, silently read "no override" →
--    fall back to default-ON — the rename would TURN A DISABLED FEATURE BACK ON.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE harness_shared.operator_flag_overrides
   SET payload = (payload - 'papercusp-learning-packs')
                 || jsonb_build_object('papercusp-knowledge-packs', payload -> 'papercusp-learning-packs'),
       updated_at = EXTRACT(EPOCH FROM now())::BIGINT * 1000
 WHERE payload ? 'papercusp-learning-packs'
   AND NOT payload ? 'papercusp-knowledge-packs';

-- A workspace holding BOTH keys (new one already written): drop the stale one.
UPDATE harness_shared.operator_flag_overrides
   SET payload = payload - 'papercusp-learning-packs'
 WHERE payload ? 'papercusp-learning-packs'
   AND payload ? 'papercusp-knowledge-packs';

COMMIT;
