-- P013/D027: native continuity is prospective and source-reconciled. A hook
-- INSERT or an exhausted activity cursor cannot establish this receipt.
-- EXCLUSIVE-LOCK: enabling the nine statement detectors briefly locks
-- agent_activity, adv_sessions and session_briefs. Metadata only: no source
-- scan, backfill or delete. The migration runner's bounded lock timeout and
-- drain protocol govern activation; ordinary hook INSERTs remain independent.
ALTER TABLE harness_shared.sql_intent_progress
  ADD COLUMN IF NOT EXISTS native_capture_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS native_capture_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS native_capture_receipt jsonb;

-- Existing index evidence can be lost or rewritten independently of transcripts.
-- Invalidate the receipt and advance the honest boundary; never backdate it.
CREATE OR REPLACE FUNCTION harness_shared.native_capture_index_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  UPDATE harness_shared.sql_intent_progress p
     SET native_capture_from=GREATEST(p.native_capture_from, removed.last_at + interval '1 microsecond'),
         native_capture_revision=p.native_capture_revision+1, native_capture_receipt=NULL
    FROM (SELECT workspace_id,harness_slug,max(created_at) last_at FROM old_activity
           WHERE kind='tool' GROUP BY workspace_id,harness_slug) removed
   WHERE p.workspace_id=removed.workspace_id AND p.harness_slug=removed.harness_slug;
  RETURN NULL;
END $fn$;
CREATE OR REPLACE FUNCTION harness_shared.native_capture_index_truncated()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  UPDATE harness_shared.sql_intent_progress SET
    native_capture_from=GREATEST(native_capture_from,clock_timestamp()),
    native_capture_revision=native_capture_revision+1,native_capture_receipt=NULL;
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION harness_shared.native_capture_index_changed() FROM PUBLIC;
REVOKE ALL ON FUNCTION harness_shared.native_capture_index_truncated() FROM PUBLIC;
CREATE OR REPLACE TRIGGER native_capture_index_delete AFTER DELETE ON harness_shared.agent_activity
  REFERENCING OLD TABLE AS old_activity FOR EACH STATEMENT
  EXECUTE FUNCTION harness_shared.native_capture_index_changed();
CREATE OR REPLACE TRIGGER native_capture_index_update AFTER UPDATE ON harness_shared.agent_activity
  REFERENCING OLD TABLE AS old_activity FOR EACH STATEMENT
  EXECUTE FUNCTION harness_shared.native_capture_index_changed();
CREATE OR REPLACE TRIGGER native_capture_index_truncate AFTER TRUNCATE ON harness_shared.agent_activity
  FOR EACH STATEMENT EXECUTE FUNCTION harness_shared.native_capture_index_truncated();
ALTER TABLE harness_shared.agent_activity ENABLE ALWAYS TRIGGER native_capture_index_delete;
ALTER TABLE harness_shared.agent_activity ENABLE ALWAYS TRIGGER native_capture_index_update;
ALTER TABLE harness_shared.agent_activity ENABLE ALWAYS TRIGGER native_capture_index_truncate;

-- A deleted/rebound runtime must not disappear from the expected population.
-- Carries change session_id in place but retain their issued home and owner.
CREATE OR REPLACE FUNCTION harness_shared.native_capture_population_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF TG_OP='UPDATE' THEN
    UPDATE harness_shared.sql_intent_progress p SET
      native_capture_from=GREATEST(p.native_capture_from,clock_timestamp()),
      native_capture_revision=p.native_capture_revision+1,native_capture_receipt=NULL
    WHERE p.workspace_id IN (SELECT o.workspace_id FROM old_sessions o JOIN new_sessions n USING(id)
      WHERE (o.workspace_id,o.coord_owner_id,o.agent,o.first_seen_at) IS DISTINCT FROM
            (n.workspace_id,n.coord_owner_id,n.agent,n.first_seen_at));
  ELSE
    UPDATE harness_shared.sql_intent_progress p SET
      native_capture_from=GREATEST(p.native_capture_from,clock_timestamp()),
      native_capture_revision=p.native_capture_revision+1,native_capture_receipt=NULL
    WHERE p.workspace_id IN (SELECT workspace_id FROM old_sessions);
  END IF;
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION harness_shared.native_capture_population_changed() FROM PUBLIC;
CREATE OR REPLACE TRIGGER native_capture_population_delete AFTER DELETE ON harness_shared.adv_sessions
  REFERENCING OLD TABLE AS old_sessions FOR EACH STATEMENT
  EXECUTE FUNCTION harness_shared.native_capture_population_changed();
CREATE OR REPLACE TRIGGER native_capture_population_update AFTER UPDATE ON harness_shared.adv_sessions
  REFERENCING OLD TABLE AS old_sessions NEW TABLE AS new_sessions FOR EACH STATEMENT
  EXECUTE FUNCTION harness_shared.native_capture_population_changed();
ALTER TABLE harness_shared.adv_sessions ENABLE ALWAYS TRIGGER native_capture_population_delete;
ALTER TABLE harness_shared.adv_sessions ENABLE ALWAYS TRIGGER native_capture_population_update;
CREATE OR REPLACE TRIGGER native_capture_population_truncate AFTER TRUNCATE ON harness_shared.adv_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION harness_shared.native_capture_index_truncated();
ALTER TABLE harness_shared.adv_sessions ENABLE ALWAYS TRIGGER native_capture_population_truncate;

-- Current scope attribution must not silently remove an earlier runtime from
-- the census. Ordinary brief/checkpoint updates do not alter this binding.
CREATE OR REPLACE FUNCTION harness_shared.native_capture_authority_changed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF TG_OP='UPDATE' THEN
    UPDATE harness_shared.sql_intent_progress p SET
      native_capture_from=GREATEST(p.native_capture_from,clock_timestamp()),
      native_capture_revision=p.native_capture_revision+1,native_capture_receipt=NULL
    WHERE p.workspace_id IN (SELECT o.workspace_id FROM old_briefs o
      WHERE NOT EXISTS (SELECT 1 FROM new_briefs n
        WHERE (o.workspace_id,o.owner_id,o.harness_slug) IS NOT DISTINCT FROM
              (n.workspace_id,n.owner_id,n.harness_slug)));
  ELSE
    UPDATE harness_shared.sql_intent_progress p SET
      native_capture_from=GREATEST(p.native_capture_from,clock_timestamp()),
      native_capture_revision=p.native_capture_revision+1,native_capture_receipt=NULL
    WHERE p.workspace_id IN (SELECT workspace_id FROM old_briefs);
  END IF;
  RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION harness_shared.native_capture_authority_changed() FROM PUBLIC;
CREATE OR REPLACE TRIGGER native_capture_authority_delete AFTER DELETE ON harness_shared.session_briefs
  REFERENCING OLD TABLE AS old_briefs FOR EACH STATEMENT
  EXECUTE FUNCTION harness_shared.native_capture_authority_changed();
CREATE OR REPLACE TRIGGER native_capture_authority_update AFTER UPDATE ON harness_shared.session_briefs
  REFERENCING OLD TABLE AS old_briefs NEW TABLE AS new_briefs FOR EACH STATEMENT
  EXECUTE FUNCTION harness_shared.native_capture_authority_changed();
CREATE OR REPLACE TRIGGER native_capture_authority_truncate AFTER TRUNCATE ON harness_shared.session_briefs
  FOR EACH STATEMENT EXECUTE FUNCTION harness_shared.native_capture_index_truncated();
ALTER TABLE harness_shared.session_briefs ENABLE ALWAYS TRIGGER native_capture_authority_delete;
ALTER TABLE harness_shared.session_briefs ENABLE ALWAYS TRIGGER native_capture_authority_update;
ALTER TABLE harness_shared.session_briefs ENABLE ALWAYS TRIGGER native_capture_authority_truncate;
