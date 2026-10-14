-- 1508: a held chat message records each superseded version once (EI-25980833213582300).
--
-- The legal-hold trigger (1320) appends the old body to held_revisions whenever an update under a
-- hold changes the body. A repair after a restore (organization-data-receipts.ts
-- repairHeldContent) copies a held row back from the pre-restore database, held_revisions
-- included, and that copy already keeps the restored row's body as a revision. The trigger then
-- recorded the same version a second time, so the repaired content never matched the pre-restore
-- e-discovery export.
--
-- A version is its body plus its edit time. An update whose new held_revisions already keeps the
-- old version is not given a second copy. This weakens nothing: a caller can only skip the append
-- by supplying that exact version itself, and the refusals (delete, erase, dropped revisions) are
-- unchanged. Edit times are compared as timestamptz, not as JSON text: to_jsonb(timestamptz)
-- formats with the writing session's time zone.

CREATE OR REPLACE FUNCTION harness_shared.chat_messages_enforce_legal_hold()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT harness_shared.chat_message_under_hold(OLD.workspace_id, OLD.data_source_id, OLD.channel_id) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'chat_message_under_legal_hold: message % in channel % cannot be deleted',
      OLD.provider_message_id, OLD.channel_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.body IS NOT NULL AND NEW.body IS NULL THEN
    RAISE EXCEPTION 'chat_message_under_legal_hold: body of message % cannot be erased',
      OLD.provider_message_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.raw IS NOT NULL AND NEW.raw IS NULL THEN
    RAISE EXCEPTION 'chat_message_under_legal_hold: raw payload of message % cannot be erased',
      OLD.provider_message_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_array_length(NEW.held_revisions) < jsonb_array_length(OLD.held_revisions) THEN
    RAISE EXCEPTION 'chat_message_under_legal_hold: held revisions of message % cannot be removed',
      OLD.provider_message_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- An edit under hold keeps the superseded body, once per version (body + edit time).
  IF OLD.body IS NOT NULL AND NEW.body IS DISTINCT FROM OLD.body
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.held_revisions) AS r(rev)
        WHERE CASE WHEN r.rev->>'body' IS NOT DISTINCT FROM OLD.body
                   THEN (r.rev->>'editedAt')::timestamptz IS NOT DISTINCT FROM OLD.edited_at
                   ELSE false END) THEN
    NEW.held_revisions := NEW.held_revisions || jsonb_build_array(jsonb_build_object(
      'body', OLD.body,
      'editedAt', OLD.edited_at,
      'supersededAt', now()));
  END IF;
  RETURN NEW;
END
$$;
