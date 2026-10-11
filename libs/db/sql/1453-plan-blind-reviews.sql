-- verification-system-improvements-2026-10-10 P-006 (D-006, D-039): blind gap reviews.
--
-- A blind reviewer sees only the owner's source turns (from the plan's latest
-- activation audit) and the running product, never the plan, its specs, rubric or
-- evidence, and records the gaps it finds. Each gap is then dispositioned to a
-- required plan item or to a Decision recorded as an accepted risk. The
-- awaiting-acceptance transition and the ship gate read this table
-- (packages/operator-core/lib/blind-review-gate.ts).
--
-- A separate table rather than new plan_audits kinds (D-039 (2)): many plan_audits
-- readers do not filter audit_kind, so new kinds there would leak into the
-- completion/activation readers.
--
-- Append-only: a recorded review or disposition is evidence, so UPDATE is refused.
-- DELETE stays allowed for plan purge and test cleanup.

CREATE TABLE IF NOT EXISTS harness_shared.plan_blind_reviews (
  id                   bigserial PRIMARY KEY,
  workspace_id         text NOT NULL,
  harness_slug         text NOT NULL,
  plan_slug            text NOT NULL,
  record_kind          text NOT NULL CHECK (record_kind IN ('review', 'disposition')),
  -- The activation audit (plan_audits.audit_seq, audit_kind='activation') the review
  -- was briefed from; a disposition names the anchor of the review it disposes.
  activation_audit_seq integer NOT NULL CHECK (activation_audit_seq > 0),
  -- review: [{ id, text }] — empty when the reviewer found no gap.
  gaps                 jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(gaps) = 'array'),
  -- disposition: [{ reviewId, gapId, itemId } | { reviewId, gapId, acceptedRiskDecisionId }]
  dispositions         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(dispositions) = 'array'),
  summary              text,
  created_by           text NOT NULL CHECK (length(btrim(created_by)) > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_blind_reviews_shape_check CHECK (
    (record_kind = 'review' AND jsonb_array_length(dispositions) = 0)
    OR (record_kind = 'disposition' AND jsonb_array_length(gaps) = 0 AND jsonb_array_length(dispositions) > 0)
  )
);

CREATE INDEX IF NOT EXISTS plan_blind_reviews_plan_idx
  ON harness_shared.plan_blind_reviews (workspace_id, plan_slug, created_at DESC);

CREATE OR REPLACE FUNCTION harness_shared.plan_blind_reviews_no_update()
RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  RAISE EXCEPTION 'plan_blind_reviews rows are append-only' USING ERRCODE = '23514';
END;
$body$;

DROP TRIGGER IF EXISTS plan_blind_reviews_no_update ON harness_shared.plan_blind_reviews;
CREATE TRIGGER plan_blind_reviews_no_update BEFORE UPDATE
  ON harness_shared.plan_blind_reviews FOR EACH ROW
  EXECUTE FUNCTION harness_shared.plan_blind_reviews_no_update();

COMMENT ON TABLE harness_shared.plan_blind_reviews IS
  'P-006 blind gap reviews (review rows) and their gap dispositions (disposition rows). Append-only. Read by evaluateBlindReviewGate (blind-review-gate.ts) at the awaiting-acceptance transition and at ship.';
