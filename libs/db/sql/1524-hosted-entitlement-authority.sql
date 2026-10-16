-- P-537 / D-067: extend the existing server-owned entitlement ledger.
-- FORWARD-COMPAT: old writers omit these columns and retain NULL authority.
-- A legacy free/paid label therefore never silently grants resource allowances.
ALTER TABLE papercusp_auth.hosted_entitlements
  ADD COLUMN IF NOT EXISTS authority jsonb,
  ADD COLUMN IF NOT EXISTS authority_revision bigint NOT NULL DEFAULT 0;

DO $authority$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'papercusp_auth.hosted_entitlements'::regclass
       AND conname = 'hosted_entitlements_authority_shape_ck'
  ) THEN
    ALTER TABLE papercusp_auth.hosted_entitlements
      ADD CONSTRAINT hosted_entitlements_authority_shape_ck CHECK (
        authority_revision >= 0 AND (
          authority IS NULL OR (
            authority_revision > 0
            AND jsonb_typeof(authority) = 'object'
            AND authority->'schemaVersion' = '1'::jsonb
            AND jsonb_typeof(authority->'bundles') = 'array'
            AND jsonb_typeof(authority->'assignments') = 'array'
            AND jsonb_typeof(authority->'overrides') = 'array'
            AND authority ?& ARRAY['schemaVersion', 'bundles', 'assignments', 'overrides']
          ) IS TRUE
        )
      );
  END IF;
END
$authority$;

COMMENT ON COLUMN papercusp_auth.hosted_entitlements.authority IS
  'Existing version-pinned bundles, assignments and overrides with per-record actor/audit receipts. NULL grants no resource allowance. Existing hosted_service DML and RLS apply.';
COMMENT ON COLUMN papercusp_auth.hosted_entitlements.authority_revision IS
  'CAS revision; admission and authority writers serialize on the same organization advisory lock.';
