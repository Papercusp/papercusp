-- Reuse the existing invocation ledger for non-HTTP expertise routes.
-- Nullable metadata leaves historical HTTP observations unchanged.
ALTER TABLE harness_shared.route_invocations
  ADD COLUMN IF NOT EXISTS metadata_json jsonb;

COMMENT ON COLUMN harness_shared.route_invocations.metadata_json IS
  'Typed internal route receipts: caller/policy/correlation, serving generation, stage timings and outcomes; no question or transcript text.';
