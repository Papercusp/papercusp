-- 1448: test_runs.configuration_snapshot — the run-time configuration a test ran under
-- (plan verification-system-improvements-2026-10-10, P-011, WI-6554700010008363).
--
-- A configuration-sensitive acceptance bar declares verification.productionConfiguration
-- ({ flags, env }). bind-spec-evidence refuses a run whose recorded configuration does not
-- match that declaration, and currentness classification never counts a fingerprint-less
-- run as current for such a bar. Both need the configuration the run actually executed
-- under, recorded by the writer at run time:
--   { schemaVersion: 1, flags: { <flag-key>: boolean }, envSha256: { <ENV>: sha256hex },
--     fingerprint: 'sha256-config-snapshot-v1:<hex>' }
-- Environment values are stored only as SHA-256 hashes (an env var can hold a secret).
--
-- WHY A COLUMN, NOT execution_details.configuration: parseTestRunExecutionDetails is a strict
-- contract (any unknown key makes the row unproven). The deployed :3070 operator parses rows
-- that working-tree writers produce, so an in-band key would make every new row unproven
-- fleet-wide until main deployed. A separate nullable column is invisible to that parser.
--
-- Additive and nullable: legacy rows and writers that predate this column stay valid. NULL
-- means "configuration not recorded", which readers treat as no fingerprint, never as a match.

ALTER TABLE harness_shared.test_runs
  ADD COLUMN IF NOT EXISTS configuration_snapshot jsonb;

COMMENT ON COLUMN harness_shared.test_runs.configuration_snapshot IS
  'P-011: run-time configuration snapshot { schemaVersion:1, flags, envSha256, fingerprint }. '
  'NULL = not recorded (never counts as matching a declared production configuration).';
