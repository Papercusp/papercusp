-- Provider IDs can be reused (notably GCP resource names). Preserve the allocation
-- identity supplied by the provider instead of losing it at the durable boundary.
-- Existing rows remain unknown: never infer an old allocation from today's VM/disk.
ALTER TABLE harness_shared.workspace_host_resources
  ADD COLUMN IF NOT EXISTS incarnation_id text;
