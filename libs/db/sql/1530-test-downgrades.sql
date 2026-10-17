-- 1530-test-downgrades.sql
-- Plan green-main-ratchet-convergence-2026-10-17, P-002 (R-1) + P-003 (R-2), decisions D-002/D-005/D-006.
--
-- Every test blocks main by default. A downgrade record makes ONE failing test case
-- non-blocking for main promotion. The record must be complete: a written reason, an
-- owner, a filed bug, the author and the time. A test in a critical area also needs an
-- acknowledgement naming that area and the risk (D-006); the owner is notified at once.
--
-- Blocking is derived from this table: a test is non-blocking only while an ACTIVE
-- (revoked_at IS NULL) row exists for it. Revoking or deleting the row makes it
-- blocking again. Rows are kept after revocation so the daily digest and the debt
-- metrics (R-9) can count downgrades per day.
--
-- FORWARD-COMPAT: this is a new table with a partial unique index; the currently
-- deployed release has no code that reads or writes test_downgrades, so nothing live
-- depends on its shape.

CREATE TABLE IF NOT EXISTS harness_shared.test_downgrades (
  id                   bigserial   PRIMARY KEY,
  workspace_id         text        NOT NULL,
  harness_slug         text        NOT NULL,
  -- The test identity (D-005): a repo-relative test file plus the full case name.
  -- A non-test gate leg (lint:tsc, a build) uses its leg id as test_file and ''
  -- as test_case.
  test_file            text        NOT NULL CHECK (length(btrim(test_file)) > 0),
  test_case            text        NOT NULL DEFAULT '',
  reason               text        NOT NULL CHECK (length(btrim(reason)) > 0),
  owner                text        NOT NULL CHECK (length(btrim(owner)) > 0),
  bug_id               text        NOT NULL CHECK (length(btrim(bug_id)) > 0),
  author               text        NOT NULL CHECK (length(btrim(author)) > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- D-006: set when the test sits in a critical area; the acknowledgement must name
  -- the area and the risk.
  critical_area        text,
  risk_acknowledgement text,
  owner_notified_at    timestamptz,
  revoked_at           timestamptz,
  revoked_by           text,
  revoke_reason        text,
  CHECK (critical_area IS NULL OR length(btrim(coalesce(risk_acknowledgement, ''))) > 0),
  CHECK (revoked_at IS NULL OR length(btrim(coalesce(revoked_by, ''))) > 0)
);

-- At most one ACTIVE downgrade per test case.
CREATE UNIQUE INDEX IF NOT EXISTS test_downgrades_active_uniq
  ON harness_shared.test_downgrades (workspace_id, harness_slug, test_file, test_case)
  WHERE revoked_at IS NULL;

-- The daily digest and per-day metrics read downgrades by creation time.
CREATE INDEX IF NOT EXISTS test_downgrades_created_idx
  ON harness_shared.test_downgrades (workspace_id, harness_slug, created_at DESC);

COMMENT ON TABLE harness_shared.test_downgrades IS
  'Per-test-case downgrade records (green-main-ratchet-convergence-2026-10-17 P-002). An active row makes one failing test non-blocking for main promotion; revoking it restores blocking. Critical-area rows carry a risk acknowledgement and an owner notice (D-006).';

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.test_downgrades TO harness_app;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.test_downgrades_id_seq TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.test_downgrades TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
