-- 1605: maintain all-time agent usage spend by workspace and harness.
--
-- goals.detail renders each linked harness's complete lifetime spend. Summing
-- agent_usage_samples on that path scans the full sample history, so keep the
-- exact workspace/harness total beside the source rows and update it atomically.

CREATE TABLE IF NOT EXISTS harness_shared.agent_usage_harness_spend_totals (
  workspace_id    TEXT NOT NULL,
  harness_slug    TEXT NOT NULL,
  total_cost_usd  DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, harness_slug)
);

COMMENT ON TABLE harness_shared.agent_usage_harness_spend_totals IS
  'All-time SUM(agent_usage_samples.cost_usd) per workspace and non-null harness_slug; maintained by a source-row trigger.';

GRANT SELECT, INSERT, UPDATE ON harness_shared.agent_usage_harness_spend_totals TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.agent_usage_harness_spend_totals TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.agent_usage_harness_spend_totals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_usage_harness_spend_totals_workspace_isolation
  ON harness_shared.agent_usage_harness_spend_totals;
CREATE POLICY agent_usage_harness_spend_totals_workspace_isolation
  ON harness_shared.agent_usage_harness_spend_totals
  USING (workspace_id = current_setting('app.workspace_id'::text, true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id'::text, true));

-- Hold source writes across the rebuild and trigger installation. Writes that
-- finish before this lock are included in the backfill; later writes wait and
-- then run through the trigger after this transaction commits.
LOCK TABLE harness_shared.agent_usage_samples IN SHARE ROW EXCLUSIVE MODE;

DELETE FROM harness_shared.agent_usage_harness_spend_totals;
INSERT INTO harness_shared.agent_usage_harness_spend_totals
  (workspace_id, harness_slug, total_cost_usd)
SELECT workspace_id, harness_slug, COALESCE(SUM(cost_usd), 0::double precision)
  FROM harness_shared.agent_usage_samples
 WHERE harness_slug IS NOT NULL
 GROUP BY workspace_id, harness_slug;

CREATE OR REPLACE FUNCTION harness_shared.maintain_agent_usage_harness_spend_totals()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.harness_slug IS NOT NULL THEN
    INSERT INTO harness_shared.agent_usage_harness_spend_totals
      (workspace_id, harness_slug, total_cost_usd)
    VALUES (OLD.workspace_id, OLD.harness_slug, -COALESCE(OLD.cost_usd, 0::double precision))
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE
      SET total_cost_usd = agent_usage_harness_spend_totals.total_cost_usd + EXCLUDED.total_cost_usd;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.harness_slug IS NOT NULL THEN
    INSERT INTO harness_shared.agent_usage_harness_spend_totals
      (workspace_id, harness_slug, total_cost_usd)
    VALUES (NEW.workspace_id, NEW.harness_slug, COALESCE(NEW.cost_usd, 0::double precision))
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE
      SET total_cost_usd = agent_usage_harness_spend_totals.total_cost_usd + EXCLUDED.total_cost_usd;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS agent_usage_harness_spend_totals_maintain
  ON harness_shared.agent_usage_samples;
CREATE TRIGGER agent_usage_harness_spend_totals_maintain
  AFTER INSERT OR UPDATE OF workspace_id, harness_slug, cost_usd OR DELETE
  ON harness_shared.agent_usage_samples
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.maintain_agent_usage_harness_spend_totals();
