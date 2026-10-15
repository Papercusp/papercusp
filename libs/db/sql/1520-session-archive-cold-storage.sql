-- P-010: retain the PG archive stamp and its owner/adv-session indexes.
-- Only blob rows move to immutable, checksum-verified compressed files.
-- The locator update and blob deletion commit atomically after cold readback.
ALTER TABLE harness_shared.session_archives
  ADD COLUMN IF NOT EXISTS cold_storage JSONB;

COMMENT ON COLUMN harness_shared.session_archives.cold_storage IS
  'Verified immutable cold archive locator {root, manifestSha256}; NULL means PG payloads';
