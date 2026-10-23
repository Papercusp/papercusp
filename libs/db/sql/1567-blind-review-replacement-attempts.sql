-- WI-6554700010022152: reserve replacement launches on the existing binding ledger.
-- Original native identities and material receipts are retained without updates.
-- lint-migrations: allow-index-swap Binding inserts use targetless ON CONFLICT DO NOTHING; no writer names the removed constraint or infers its old column list. The partial original index preserves the same activation uniqueness for every legacy insert, whose replacement_of defaults to NULL.
-- FORWARD-COMPAT: existing binding inserts omit the new columns and keep attempt_seq=0,
-- replacement_of=NULL and their complete native identity. The widened status check admits
-- every old status. No material row changes. Targetless ON CONFLICT continues to work with
-- the replacement indexes, and original activation uniqueness remains enforced atomically.
ALTER TABLE harness_shared.plan_blind_review_sessions
  ADD COLUMN replacement_of bigint REFERENCES harness_shared.plan_blind_review_sessions(id),
  ADD COLUMN attempt_seq integer NOT NULL DEFAULT 0,
  ADD COLUMN request_key text,
  ADD COLUMN request_hash text,
  ADD COLUMN requested_by text,
  ADD COLUMN request_snapshot jsonb,
  ADD COLUMN launch_key text,
  ADD COLUMN launch_result jsonb;

ALTER TABLE harness_shared.plan_blind_review_sessions
  DROP CONSTRAINT plan_blind_review_sessions_plan_activation_uidx,
  DROP CONSTRAINT plan_blind_review_sessions_status_check,
  ALTER COLUMN reviewer_owner_id DROP NOT NULL,
  ALTER COLUMN adv_session_id DROP NOT NULL,
  ALTER COLUMN native_session_id DROP NOT NULL,
  ADD CONSTRAINT plan_blind_review_sessions_status_check
    CHECK (status IN ('ready', 'resuming', 'posted', 'closed', 'failed', 'launching', 'uncertain')),
  ADD CONSTRAINT plan_blind_review_sessions_attempt_shape_check CHECK (
    (replacement_of IS NULL AND attempt_seq = 0 AND request_key IS NULL AND launch_key IS NULL)
    OR (replacement_of IS NOT NULL AND attempt_seq > 0 AND request_key IS NOT NULL AND length(request_key) > 0
      AND request_hash IS NOT NULL AND length(request_hash) = 64 AND requested_by IS NOT NULL AND length(requested_by) > 0
      AND request_snapshot IS NOT NULL AND jsonb_typeof(request_snapshot) = 'object' AND launch_key IS NOT NULL AND length(launch_key) > 0)
  ),
  ADD CONSTRAINT plan_blind_review_sessions_native_shape_check CHECK (
    (reviewer_owner_id IS NOT NULL AND adv_session_id IS NOT NULL AND native_session_id IS NOT NULL)
    OR (replacement_of IS NOT NULL AND status IN ('launching', 'uncertain', 'failed')
      AND reviewer_owner_id IS NULL AND adv_session_id IS NULL AND native_session_id IS NULL)
  );

CREATE UNIQUE INDEX plan_blind_review_sessions_original_activation_uidx
  ON harness_shared.plan_blind_review_sessions (workspace_id, plan_slug, activation_audit_seq)
  WHERE replacement_of IS NULL;
CREATE UNIQUE INDEX plan_blind_review_sessions_replacement_sequence_uidx
  ON harness_shared.plan_blind_review_sessions (replacement_of, attempt_seq);
CREATE UNIQUE INDEX plan_blind_review_sessions_replacement_request_uidx
  ON harness_shared.plan_blind_review_sessions (replacement_of, request_key);
CREATE UNIQUE INDEX plan_blind_review_sessions_active_replacement_uidx
  ON harness_shared.plan_blind_review_sessions (replacement_of)
  WHERE replacement_of IS NOT NULL AND status <> 'failed';
CREATE UNIQUE INDEX plan_blind_review_sessions_launch_key_uidx
  ON harness_shared.plan_blind_review_sessions (workspace_id, launch_key)
  WHERE launch_key IS NOT NULL;
