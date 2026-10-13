-- WI-6554700010010429: deliberate fleet termination must survive resume's
-- reconciliation of ended_at/ended_by. Additive for the serving older runtime.
ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS retired_at timestamptz,
  ADD COLUMN IF NOT EXISTS retired_by text,
  ADD COLUMN IF NOT EXISTS retired_reason text;

COMMENT ON COLUMN harness_shared.adv_sessions.retired_at IS
  'Deliberate operator retirement. Routine wake/resume cannot clear it; successful explicit relaunch may.';
COMMENT ON COLUMN harness_shared.adv_sessions.retired_by IS
  'Retirement authority, such as fleet:kill:<actor owner id>.';
COMMENT ON COLUMN harness_shared.adv_sessions.retired_reason IS
  'Audited reason for deliberate retirement, separate from process exit evidence.';
