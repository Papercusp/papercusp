-- P002/P003 D018: retain independent eligibility at edit time, after peers release locks.
-- Reuse each candidate edit row; NULL means unobserved, never ineligible.
ALTER TABLE harness_shared.edit_attribution_ledger
  ADD COLUMN IF NOT EXISTS signal_eligibility jsonb;

COMMENT ON COLUMN harness_shared.edit_attribution_ledger.signal_eligibility IS
  'Versioned independent edit-time verdicts keyed by signal. interface includes '
  'capturedAt, verdict eligible/ineligible/unknown, reason, beforeSha256, afterSha256, '
  'changedExports and captured peerEvidence. NULL means not measured. '
  'All edit acquisition paths are included; Bash/heredoc writes are outside push eligibility.';
