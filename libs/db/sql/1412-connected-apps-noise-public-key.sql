-- 1412: the paired phone's static Noise public key (WI-10006956, android-public-release-2026-10-01 D-013 #6).
--
-- On a BYOC cloud workspace every device-http content frame is sealed end to end with the
-- Noise XX channel in byoc-sealed-channel.ts. The machine's static public key travels in the
-- pair QR; the phone's static public key is registered here when the pair token is redeemed,
-- so the machine can pin the remote key of each paired phone. Only a public key is stored;
-- the phone's private key never leaves the phone.
--
-- Expand-only: a nullable column plus a CHECK that admits NULL. The deployed release never
-- writes it, and every existing row satisfies the CHECK.

ALTER TABLE harness_shared.connected_apps
  ADD COLUMN IF NOT EXISTS noise_public_key text;

COMMENT ON COLUMN harness_shared.connected_apps.noise_public_key IS
  'A paired phone''s static Noise public key: canonical base64 of 32 bytes. Set at pair redeem when the machine advertised a Noise key (a hosted BYOC machine); NULL otherwise. Public material only.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'connected_apps_noise_public_key_check'
       AND conrelid = 'harness_shared.connected_apps'::regclass
  ) THEN
    ALTER TABLE harness_shared.connected_apps
      ADD CONSTRAINT connected_apps_noise_public_key_check CHECK (
        noise_public_key IS NULL
        OR (kind = 'mobile' AND noise_public_key ~ '^[A-Za-z0-9+/]{43}=$')
      );
  END IF;
END
$$;
