-- 1468: the in-app chat bug intake is gone (cupboard-distributable-integrations-2026-10-10 D-025
-- ruling 5). Slack bug reports now arrive through the slack package's socket ingress and are filed
-- by the bug-triage package; nothing in app code writes or reads the chat admission sink.
--
-- Expand/contract. This is the part the release still serving :3070 does not depend on:
--
-- 1. The chat admission sink's change-notify trigger on trigger_deliveries (mig 1409) and its
--    failed-delivery index (mig 1410). Only rows with sink_kind 'data-source-chat-admission' fired
--    or used them, and no source writes such rows any more: the one Slack source moved to the
--    package socket path (D-023), which records through the provider ingress sink.
-- 2. admission_rules is pinned to what rules now are: record rules that admit. The chat rule kinds
--    (chat-message, chat-thread) and the 'suggest' action existed only for the deleted chat sink.
--    Measured before writing: the workspace holds one rule (record, admit) and no other shape.
--
-- Contract later (separate migration, once :3070 serves a build without
-- data-sources/chat-bugs-overview.ts): DROP TABLE harness_shared.chat_bug_suggestions. The
-- deployed release still reads that table for the Slack-bugs card on /admin/admission.

-- FORWARD-COMPAT: the deployed release's queries stay correct without trigger_deliveries_chat_admission_failed_idx (an index only speeds them) and nothing in it requires emit_change_notify_chat_admission_trg; both only served chat-sink rows, which no source writes since D-023 moved the Slack source to the package path.
DROP TRIGGER IF EXISTS emit_change_notify_chat_admission_trg ON harness_shared.trigger_deliveries;
DROP INDEX IF EXISTS harness_shared.trigger_deliveries_chat_admission_failed_idx;

-- 3. The slack-org-sync routine (mig 1333). Its action, system:slack-org-sync, was deleted with
--    the in-app Slack organization data source (D-026); the slack package now owns history
--    backfill through the generic connector-sync routine. Measured before writing: no
--    organization-scope Slack source exists, so the routine synced nothing.
-- FORWARD-COMPAT: the deployed release still registers system:slack-org-sync, but nothing in it requires this routine row; without the row the action simply never fires, and it had no source to sync.
DELETE FROM harness_shared.routines WHERE id = 'rt_papercusp_slack_org_sync';

-- Stale rows of the removed shapes cannot exist (measured: none), but refuse to migrate over one
-- rather than delete a person's rule silently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM harness_shared.admission_rules WHERE source_kind <> 'record' OR action <> 'admit'
  ) THEN
    RAISE EXCEPTION '1468: admission_rules holds a chat or suggest rule; disable and delete it before migrating';
  END IF;
END $$;

-- FORWARD-COMPAT: the deployed release inserts rules with action 'admit' and source_kind 'record' unless a caller explicitly asks for a chat or suggest rule, and no caller does (no such rule exists).
ALTER TABLE harness_shared.admission_rules DROP CONSTRAINT IF EXISTS admission_rules_action_check;
ALTER TABLE harness_shared.admission_rules
  ADD CONSTRAINT admission_rules_action_check CHECK (action = 'admit');

ALTER TABLE harness_shared.admission_rules DROP CONSTRAINT IF EXISTS admission_rules_source_kind_check;
ALTER TABLE harness_shared.admission_rules
  ADD CONSTRAINT admission_rules_source_kind_check CHECK (source_kind = 'record');
