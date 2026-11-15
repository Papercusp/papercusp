-- Existing-local-install portal desktops P-002. Additive expansion of the existing
-- singleton. Legacy links retain app-only authority until the approving account
-- is known and a person at this computer separately grants desktop access.
\set ON_ERROR_STOP on

ALTER TABLE harness_shared.remote_access_portal_relay
  ADD COLUMN IF NOT EXISTS linked_user_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS desktop_grant JSONB NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'harness_shared.remote_access_portal_relay'::regclass
      AND conname = 'portal_relay_desktop_grant_binding_ck') THEN
    ALTER TABLE harness_shared.remote_access_portal_relay
      ADD CONSTRAINT portal_relay_desktop_grant_binding_ck CHECK (
        desktop_grant IS NULL OR (
          state = 'linked' AND consented_at IS NOT NULL
          AND jsonb_typeof(desktop_grant) = 'object'
          AND desktop_grant->>'version' = '1'
          AND length(desktop_grant->>'id') > 0
          AND desktop_grant->>'installId' = install_id
          AND desktop_grant->>'portalOrigin' = portal_origin
          AND desktop_grant->>'userId' = linked_user_id
          AND desktop_grant->>'organizationId' = organization_id
          AND desktop_grant->>'customerWorkspaceId' = customer_workspace_id
          AND length(desktop_grant->>'localWorkspaceId') > 0
          AND desktop_grant->>'browserPublicKey' ~ '^[A-Za-z0-9+/]{43}=$'
          AND desktop_grant->'view' = 'true'::jsonb
          AND jsonb_typeof(desktop_grant->'control') = 'boolean'
          AND length(desktop_grant->>'grantedAt') > 0
        ) IS TRUE
      );
  END IF;
END $$;

COMMENT ON COLUMN harness_shared.remote_access_portal_relay.linked_user_id IS
  'User proven by consumed portal device approval. NULL legacy links stay app-only.';
COMMENT ON COLUMN harness_shared.remote_access_portal_relay.desktop_grant IS
  'Separate local consent bound to install, portal account, browser Noise key and local workspace; never implied by app consent. Cleared on unlink/relink.';
