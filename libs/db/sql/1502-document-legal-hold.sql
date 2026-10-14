-- 1502: legal holds enforced on the document route (plan papercusp-enterprise-readiness-roadmap-2026-10-09
-- P-017, child P-017a WI-6554700010012462).
--
-- Migration 1320 added harness_shared.data_source_legal_holds and enforced it on chat_messages only.
-- Every other connector (mail, calendar, Asana, GitHub, ...) keeps its content ONLY in
-- harness_shared.documents, so a hold on such a source did not stop that content from being deleted.
-- This migration reuses the same hold table (no parallel table) and enforces it on documents:
--
--   * A document is under hold when its source_id names a data source with an ACTIVE hold, and the
--     hold covers the whole source (channel_id IS NULL) or the document's provider container: the
--     document's metadata channelId, or its permission list's source_ref. Connector lists are keyed
--     '<source id>#<container>' (operator-core containerPermissionRef); a bare '<container>' also
--     matches.
--   * Chat-derived documents are exempt. Kinds chat-message, chat-thread and chat-window are renders
--     of harness_shared.chat_messages, which 1320 already holds (with edit revisions); re-rollup must
--     stay free to replace them. operator-core chat-retrieval-units.ts owns these kind names
--     (CHAT_DERIVED_DOCUMENT_KINDS) and an integration test pins this list to them.
--   * Under hold, DELETE is refused (including a cascade from users), as is an UPDATE that erases the
--     text or moves the row to another workspace or source. Other updates (embeddings, metadata,
--     re-sync of the same content) pass. The trigger fires only on UPDATE OF the guarded columns.
--
-- Additive: three functions, one trigger. No hold rows exist before an operator places one, so the
-- release currently serving is unaffected until then.

CREATE OR REPLACE FUNCTION harness_shared.document_is_chat_derived(p_kind text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_kind IN ('chat-message', 'chat-thread', 'chat-window')
$$;

COMMENT ON FUNCTION harness_shared.document_is_chat_derived(text) IS
  'P-017a: document kinds rendered from harness_shared.chat_messages. Their content is held in chat_messages, so document legal holds exempt them. Pinned to chat-retrieval-units.ts CHAT_DERIVED_DOCUMENT_KINDS by an integration test.';

-- Whether a hold's container (channel_id; NULL = the whole source) covers a document of the held source.
CREATE OR REPLACE FUNCTION harness_shared.document_hold_container_matches(
  p_workspace_id text, p_source_id uuid, p_hold_channel_id text, p_metadata jsonb, p_permission_list_id uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_hold_channel_id IS NULL
      OR p_hold_channel_id = p_metadata ->> 'channelId'
      OR EXISTS (
        SELECT 1
          FROM harness_shared.document_permission_lists l
         WHERE l.workspace_id = p_workspace_id
           AND l.id = p_permission_list_id
           AND l.source_ref IN (p_hold_channel_id, p_source_id::text || '#' || p_hold_channel_id))
$$;

COMMENT ON FUNCTION harness_shared.document_hold_container_matches(text, uuid, text, jsonb, uuid) IS
  'P-017a: a hold container covers a document when the hold is source-wide, or names the document channelId or its permission-list container (<source id>#<container> or a bare <container>).';

CREATE OR REPLACE FUNCTION harness_shared.document_under_hold(
  p_workspace_id text, p_source_id uuid, p_kind text, p_metadata jsonb, p_permission_list_id uuid)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_source_id IS NOT NULL
     AND NOT harness_shared.document_is_chat_derived(p_kind)
     AND EXISTS (
       SELECT 1
         FROM harness_shared.data_source_legal_holds h
        WHERE h.workspace_id = p_workspace_id
          AND h.data_source_id = p_source_id
          AND h.released_at IS NULL
          AND harness_shared.document_hold_container_matches(
                p_workspace_id, p_source_id, h.channel_id, p_metadata, p_permission_list_id))
$$;

COMMENT ON FUNCTION harness_shared.document_under_hold(text, uuid, text, jsonb, uuid) IS
  'P-017a: true when an active data_source_legal_holds row covers this document (whole source, or its channelId / permission-list container). Chat-derived kinds are exempt.';

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
  IF btrim(OLD.text) <> '' AND btrim(coalesce(NEW.text, '')) = '' THEN
    RAISE EXCEPTION 'document_under_legal_hold: text of document % cannot be erased',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS documents_enforce_legal_hold ON harness_shared.documents;
CREATE TRIGGER documents_enforce_legal_hold
  BEFORE UPDATE OF workspace_id, source_id, text OR DELETE ON harness_shared.documents
  FOR EACH ROW EXECUTE FUNCTION harness_shared.documents_enforce_legal_hold();

GRANT EXECUTE ON FUNCTION harness_shared.document_is_chat_derived(text) TO harness_app, harness_admin;
GRANT EXECUTE ON FUNCTION harness_shared.document_hold_container_matches(text, uuid, text, jsonb, uuid) TO harness_app, harness_admin;
GRANT EXECUTE ON FUNCTION harness_shared.document_under_hold(text, uuid, text, jsonb, uuid) TO harness_app, harness_admin;
