-- WI-10001739 link 3b: let the hosted-lifecycle reconciler read DBOS workflow liveness.
--
-- `reconcileHostedLifecycleJobs` runs through `withWorkspace`, i.e. as plain `harness_app`.
-- It decided whether a lifecycle operation was abandoned using ONLY row recency
-- (`recovery_attempts` + `heartbeat_at || updated_at` age), so a workflow DBOS was still
-- actively executing could be reaped and marked failed purely for looking old — and the
-- reaper then wrote its own verdict over the operation's real terminal cause (link 3a).
--
-- The authoritative liveness signal is `dbos.workflow_status.status`, but `harness_app`
-- could not see it at all:
--     has_schema_privilege('harness_app','dbos','USAGE')                  = false
--     has_table_privilege('harness_app','dbos.workflow_status','SELECT')  = false
-- so the probe would have thrown on every sweep: silently inert at best, and — if the read
-- were placed inside the sweep's own `FOR UPDATE` transaction — an abort of the entire
-- workspace reconciliation on every run.
--
-- This grant is READ-ONLY and as narrow as the question: USAGE on the schema plus SELECT on
-- the single status relation. It confers no write, no DDL, and no access to any other dbos
-- relation. `harness_admin` owns both the schema and the table, and migrations run as
-- `harness_admin`, so this is within the migration runner's own authority.
--
-- Not destructive and not expand/contract: a grant that no deployed code exercises yet is
-- inert for the currently-serving release, so no FORWARD-COMPAT acknowledgment is required.

GRANT USAGE ON SCHEMA dbos TO harness_app;
GRANT SELECT ON dbos.workflow_status TO harness_app;
