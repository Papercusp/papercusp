-- P-016: extend the existing hosted billing ledger, not a second event system.
-- API provenance never substitutes for the digest of signed webhook bytes.
ALTER TABLE papercusp_auth.hosted_billing_customers
  ADD COLUMN IF NOT EXISTS reconciliation_checkpoint jsonb;
ALTER TABLE papercusp_auth.hosted_billing_webhook_events
  ALTER COLUMN body_digest DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS fact_digest text,
  ADD COLUMN IF NOT EXISTS api_observation jsonb;

DO $mig1515$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hosted_billing_reconciliation_checkpoint_ck'
    AND conrelid = 'papercusp_auth.hosted_billing_customers'::regclass) THEN
    ALTER TABLE papercusp_auth.hosted_billing_customers ADD CONSTRAINT hosted_billing_reconciliation_checkpoint_ck CHECK ((
    reconciliation_checkpoint IS NULL OR (
      jsonb_typeof(reconciliation_checkpoint) = 'object'
      AND reconciliation_checkpoint ?& ARRAY['accountId', 'organizationId', 'customerId', 'livemode',
        'createdFrom', 'createdBefore', 'startingAfter', 'revision', 'complete', 'cursors']
      AND reconciliation_checkpoint->>'organizationId' = organization_id::text
      AND reconciliation_checkpoint->>'customerId' = stripe_customer_id
      AND (reconciliation_checkpoint->>'livemode')::boolean = livemode
      AND reconciliation_checkpoint->>'accountId' ~ '^acct_[A-Za-z0-9]+$'
      AND jsonb_typeof(reconciliation_checkpoint->'cursors') = 'array'
      AND (reconciliation_checkpoint->>'revision')::bigint > 0
      AND (reconciliation_checkpoint->>'createdFrom')::bigint >= 0
      AND (reconciliation_checkpoint->>'createdBefore')::bigint > (reconciliation_checkpoint->>'createdFrom')::bigint
      AND jsonb_typeof(reconciliation_checkpoint->'complete') = 'boolean'
    )
    ) IS TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hosted_billing_fact_digest_ck'
    AND conrelid = 'papercusp_auth.hosted_billing_webhook_events'::regclass) THEN
    ALTER TABLE papercusp_auth.hosted_billing_webhook_events ADD CONSTRAINT hosted_billing_fact_digest_ck CHECK (fact_digest IS NULL OR fact_digest ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hosted_billing_api_observation_ck'
    AND conrelid = 'papercusp_auth.hosted_billing_webhook_events'::regclass) THEN
    ALTER TABLE papercusp_auth.hosted_billing_webhook_events ADD CONSTRAINT hosted_billing_api_observation_ck CHECK ((
    (body_digest IS NOT NULL OR api_observation IS NOT NULL)
    AND (body_digest IS NOT NULL OR (outcome = 'ignored' AND rejection_code IS NULL))
    AND (api_observation IS NULL OR (
      jsonb_typeof(api_observation) = 'object'
      AND api_observation ?& ARRAY['source', 'accountId', 'apiObjectDigest', 'factDigest', 'observedAtMs', 'requestIds', 'evidenceRef']
      AND api_observation->>'source' = 'stripe-authenticated-api'
      AND api_observation->>'accountId' ~ '^acct_[A-Za-z0-9]+$'
      AND api_observation->>'apiObjectDigest' ~ '^[0-9a-f]{64}$'
      AND api_observation->>'factDigest' ~ '^[0-9a-f]{64}$'
      AND (fact_digest IS NULL OR fact_digest = api_observation->>'factDigest')
      AND api_observation->>'evidenceRef' ~ '^stripe-billing-page:[0-9a-f]{64}$'
      AND jsonb_typeof(api_observation->'requestIds') = 'array'
      AND jsonb_array_length(api_observation->'requestIds') = 3
      AND (api_observation->>'observedAtMs')::bigint > 0
    ))
    ) IS TRUE);
  END IF;
END
$mig1515$;
COMMENT ON COLUMN papercusp_auth.hosted_billing_webhook_events.body_digest IS
  'SHA256 of original signed webhook bytes only. NULL means no signed delivery has been received; API recovery cannot populate or replace this value.';
COMMENT ON COLUMN papercusp_auth.hosted_billing_webhook_events.api_observation IS
  'Authenticated Stripe API object/fact commitments and request provenance; independent of signed-delivery outcome and body digest.';
COMMENT ON COLUMN papercusp_auth.hosted_billing_customers.reconciliation_checkpoint IS
  'Server-pinned fixed event window, visited cursors and revision. Advanced in the same hosted_service transaction as recovery facts and audit receipts.';
