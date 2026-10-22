-- WI-6554700010019373: bind each blind review to the exact confined native
-- reviewer session minted for the plan's current activation audit.
-- The session row is mutable only for its resume lease and final review receipt;
-- native identity/profile/confinement fields are snapshots checked by the writer.

ALTER TABLE harness_shared.plan_blind_reviews
  ADD COLUMN IF NOT EXISTS idempotency_key text;

-- FORWARD-COMPAT: the deployed release does not know this new column; its
-- inserts leave idempotency_key NULL, and its ON CONFLICT targets cannot
-- infer this partial index, so the index cannot reject an old writer.

CREATE UNIQUE INDEX IF NOT EXISTS plan_blind_reviews_review_idempotency_uidx
  ON harness_shared.plan_blind_reviews (workspace_id, idempotency_key)
  WHERE record_kind = 'review' AND idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS harness_shared.plan_blind_review_sessions (
  id                    bigserial PRIMARY KEY,
  workspace_id          text NOT NULL,
  harness_slug          text NOT NULL,
  plan_slug             text NOT NULL,
  activation_audit_seq  integer NOT NULL CHECK (activation_audit_seq > 0),
  reviewer_owner_id     text NOT NULL CHECK (length(btrim(reviewer_owner_id)) > 0),
  adv_session_id        bigint NOT NULL UNIQUE CHECK (adv_session_id > 0),
  native_session_id     text NOT NULL UNIQUE CHECK (length(btrim(native_session_id)) > 0),
  launch_parent_owner   text NOT NULL CHECK (launch_parent_owner = 'system:blind-gap-review'),
  account_route         text,
  model_spec            text,
  confinement_snapshot  jsonb NOT NULL CHECK (jsonb_typeof(confinement_snapshot) = 'object'),
  status                text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'resuming', 'posted', 'closed', 'failed')),
  resume_lease_id       uuid,
  resume_lease_expires_at timestamptz,
  review_id             bigint,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_blind_review_sessions_plan_activation_uidx
    UNIQUE (workspace_id, plan_slug, activation_audit_seq),
  CONSTRAINT plan_blind_review_sessions_owner_uidx
    UNIQUE (workspace_id, reviewer_owner_id),
  CONSTRAINT plan_blind_review_sessions_lease_pair_check CHECK (
    (resume_lease_id IS NULL) = (resume_lease_expires_at IS NULL)
  ),
  CONSTRAINT plan_blind_review_sessions_lease_state_check CHECK (
    (status = 'resuming') = (resume_lease_id IS NOT NULL)
  ),
  CONSTRAINT plan_blind_review_sessions_review_shape_check CHECK (
    (status = 'posted') = (review_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS plan_blind_review_sessions_expired_lease_idx
  ON harness_shared.plan_blind_review_sessions (resume_lease_expires_at)
  WHERE status = 'resuming';

COMMENT ON TABLE harness_shared.plan_blind_review_sessions IS
  'Exact native reviewer bindings for plans:blind-review recovery. Resume claims an atomic lease, then revalidates the source adv_sessions row and persisted confinement before fork:false.';

COMMENT ON COLUMN harness_shared.plan_blind_review_sessions.confinement_snapshot IS
  'Immutable launch-time SessionToolConfinement snapshot; resume refuses if the authoritative stored confinement is missing or differs.';

COMMENT ON COLUMN harness_shared.plan_blind_reviews.idempotency_key IS
  'Stable reviewer-session key used to make repeated post calls return the original review row.';
