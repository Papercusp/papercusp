-- P-003: bare-plugin credentials belonged to the deleted adapter. Never let
-- the provider driver mistake an unreadable credential for an anonymous source.
-- A normal descriptor reconnect upserts the SAME owner/account/source row.
UPDATE harness_shared.data_sources
   SET status = 'reconnect_required',
       last_error = 'provider_facebook_reconnect_required:connect_installed_provider',
       updated_at = now()
 WHERE kind = 'facebook'
   AND credential_ref LIKE 'facebook-personal-vault:%'
   AND status <> 'disabled';
