-- 1503: organization document sealing (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-016b
-- follow-up, WI-6554700010012443 unit U2; decision D-020).
--
-- An organization that provisioned a customer-managed key (organization_key_custody, migration 1501)
-- has its organization- and pot-scope documents sealed under its data-encryption key (DEK):
--
--   * title and text are stored empty. The content lives in sealed_content: an envelope-v2 blob
--     (operator-core data-governance/organization-keys.ts, sealed scope 'content') of the JSON
--     {title, text}. text_tsv and documents_bm25 therefore index nothing for a sealed row, and the
--     plaintext search leg never matches it.
--   * blind_terms holds keyed tokens of the row's stemmed lexemes (the same to_tsvector('english')
--     that text_tsv uses). Each token is an HMAC under a key derived from the DEK version that sealed
--     the row (data-governance/organization-content-sealing.ts). A search sends the query's tokens
--     under every live DEK version, selects candidates by overlap, decrypts them and applies the exact
--     websearch match and ts_rank_cd after decryption.
--   * A database reader learns, per organization, which sealed rows share a stemmed term and how often
--     a term occurs. It does not learn the terms or the content. Participants and metadata stay
--     plaintext.
--
-- The 1502 legal-hold rule refused an UPDATE that empties text. Sealing a held plaintext row empties
-- text while it moves the content into sealed_content, so the rule now treats either column as the
-- content: the update is refused only when BOTH end up empty. The trigger also fires on UPDATE OF
-- sealed_content.
--
-- Additive: two nullable columns; one CHECK that constrains only rows that carry sealed_content or
-- blind_terms, which no running release writes; one partial GIN index; a replacement of the 1502
-- function that refuses strictly fewer updates from a release that never writes sealed_content.

ALTER TABLE harness_shared.documents
  ADD COLUMN IF NOT EXISTS sealed_content bytea,
  ADD COLUMN IF NOT EXISTS blind_terms text[];

COMMENT ON COLUMN harness_shared.documents.sealed_content IS
  'P-016b U2: envelope-v2 blob (organization DEK, scope content) of JSON {title,text}; title and text are then empty. NULL = plaintext row.';
COMMENT ON COLUMN harness_shared.documents.blind_terms IS
  'P-016b U2: HMAC tokens of the stemmed lexemes of a sealed row, keyed per organization DEK version. NULL exactly when sealed_content is NULL.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'harness_shared.documents'::regclass AND conname = 'documents_sealed_content_shape'
  ) THEN
    ALTER TABLE harness_shared.documents ADD CONSTRAINT documents_sealed_content_shape CHECK (
      (sealed_content IS NULL AND blind_terms IS NULL)
      OR (sealed_content IS NOT NULL AND blind_terms IS NOT NULL
          AND title = '' AND text = '' AND scope IN ('organization', 'pot'))
    );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS documents_blind_terms_gin
  ON harness_shared.documents USING gin (blind_terms)
  WHERE sealed_content IS NOT NULL;

CREATE OR REPLACE FUNCTION harness_shared.documents_enforce_legal_hold()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT harness_shared.document_under_hold(
       OLD.workspace_id, OLD.source_id, OLD.kind, OLD.metadata, OLD.permission_list_id) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document_under_legal_hold: document % of data source % cannot be deleted',
      OLD.id, OLD.source_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.source_id IS DISTINCT FROM OLD.source_id THEN
    RAISE EXCEPTION 'document_under_legal_hold: document % cannot be moved out of held data source %',
      OLD.id, OLD.source_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- Content is the plaintext text or the sealed blob (migration 1503). Sealing or unsealing moves it.
  IF (btrim(OLD.text) <> '' OR OLD.sealed_content IS NOT NULL)
     AND btrim(coalesce(NEW.text, '')) = '' AND NEW.sealed_content IS NULL THEN
    RAISE EXCEPTION 'document_under_legal_hold: content of document % cannot be erased',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS documents_enforce_legal_hold ON harness_shared.documents;
CREATE TRIGGER documents_enforce_legal_hold
  BEFORE UPDATE OF workspace_id, source_id, text, sealed_content OR DELETE ON harness_shared.documents
  FOR EACH ROW EXECUTE FUNCTION harness_shared.documents_enforce_legal_hold();
