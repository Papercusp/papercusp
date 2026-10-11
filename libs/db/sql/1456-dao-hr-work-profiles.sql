-- 1456-dao-hr-work-profiles.sql — DAO HR work profile (dao-hr-people-2026-10-11 P-002, R-1).
--
-- A work profile is the HR view of ONE person inside ONE DAO. It hangs off the
-- shared person record — the canonical PER- entity in harness_shared.work_items
-- (item_kind = 'person') that the relationship graph already owns — and adds
-- only work facts: role, team, manager, level, start date, engagement type,
-- jurisdiction, lifecycle status, pay terms (D-005), the DAO member identity
-- (GitHub principal, as hive memberships key it) and the verified wallet link.
--
-- ⚠ NO CONTACT COLUMNS. Names, emails, phones and postal addresses live on the
-- person record only; a second contact store for HR is exactly what R-1 rules
-- out. The dao-hr schema guard (packages/operator-core/lib/dao-hr/schema-guard.ts)
-- fails the build when any dao-hr migration adds such a column to a table other
-- than the person record — `wallet_address` is a machine address, not contact data.
--
-- person_id stores the SURVIVOR id: the writer resolves merges through
-- getCanonicalEntity before saving, so a profile never points at a retired row.
-- Existence of the person record is checked by the writer (the person row is a
-- work_items record, which has no single-column key a foreign key could target).
--
-- FORWARD-COMPAT: purely additive (one new table + indexes + policy); nothing
-- the currently-deployed release reads changes.

CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_work_profiles (
  workspace_id          text        NOT NULL,
  dao_slug              text        NOT NULL CHECK (length(btrim(dao_slug)) BETWEEN 1 AND 200),
  person_id             text        NOT NULL CHECK (person_id ~ '^PER-'),
  title                 text        NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  team                  text        CHECK (team IS NULL OR length(btrim(team)) BETWEEN 1 AND 200),
  manager_person_id     text        CHECK (manager_person_id IS NULL OR manager_person_id ~ '^PER-'),
  level                 text        CHECK (level IS NULL OR length(btrim(level)) BETWEEN 1 AND 100),
  start_date            date,
  engagement_type       text        NOT NULL CHECK (engagement_type IN ('employee', 'contractor')),
  jurisdiction          text        NOT NULL CHECK (length(btrim(jurisdiction)) BETWEEN 2 AND 64),
  status                text        NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'offered', 'onboarding', 'active', 'offboarded')),
  pay_amount            numeric(18, 2) CHECK (pay_amount IS NULL OR pay_amount >= 0),
  pay_currency          text        CHECK (pay_currency IS NULL OR pay_currency ~ '^[A-Z]{3}$'),
  pay_cadence           text        CHECK (pay_cadence IS NULL OR pay_cadence IN ('hourly', 'weekly', 'biweekly', 'monthly', 'annual', 'per-milestone')),
  member_github_user_id bigint      CHECK (member_github_user_id IS NULL OR member_github_user_id > 0),
  wallet_address        text        CHECK (wallet_address IS NULL OR wallet_address ~ '^0x[0-9a-f]{40}$'),
  wallet_chain_id       integer     CHECK (wallet_chain_id IS NULL OR wallet_chain_id > 0),
  wallet_binding_ref    text,
  wallet_verified_at    timestamptz,
  onboarded_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, dao_slug, person_id),
  -- Pay terms are all-or-nothing: an amount without a currency or cadence is not a term.
  CONSTRAINT dao_hr_work_profiles_pay_terms_complete CHECK (
    (pay_amount IS NULL AND pay_currency IS NULL AND pay_cadence IS NULL)
    OR (pay_amount IS NOT NULL AND pay_currency IS NOT NULL AND pay_cadence IS NOT NULL)
  ),
  -- A wallet link exists only as a whole verified binding, never a bare address.
  CONSTRAINT dao_hr_work_profiles_wallet_link_verified CHECK (
    (wallet_address IS NULL AND wallet_chain_id IS NULL AND wallet_binding_ref IS NULL AND wallet_verified_at IS NULL)
    OR (wallet_address IS NOT NULL AND wallet_chain_id IS NOT NULL AND wallet_binding_ref IS NOT NULL
        AND wallet_verified_at IS NOT NULL AND member_github_user_id IS NOT NULL)
  ),
  -- SPEC-P-002-A, enforced in the store as well as the writer: nobody is onboarded
  -- (onboarding finished → active / offboarded) without a verified wallet link.
  CONSTRAINT dao_hr_work_profiles_onboarded_needs_wallet CHECK (
    onboarded_at IS NULL OR wallet_verified_at IS NOT NULL
  ),
  CONSTRAINT dao_hr_work_profiles_active_is_onboarded CHECK (
    status NOT IN ('active', 'offboarded') OR onboarded_at IS NOT NULL
  ),
  CONSTRAINT dao_hr_work_profiles_not_own_manager CHECK (
    manager_person_id IS NULL OR manager_person_id <> person_id
  )
);

-- One DAO member identity maps to at most one profile per DAO.
CREATE UNIQUE INDEX IF NOT EXISTS dao_hr_work_profiles_member_uniq
  ON harness_shared.dao_hr_work_profiles (workspace_id, dao_slug, member_github_user_id)
  WHERE member_github_user_id IS NOT NULL;

-- The people view lists a DAO's profiles by status and walks reporting lines.
CREATE INDEX IF NOT EXISTS dao_hr_work_profiles_status_idx
  ON harness_shared.dao_hr_work_profiles (workspace_id, dao_slug, status);
CREATE INDEX IF NOT EXISTS dao_hr_work_profiles_manager_idx
  ON harness_shared.dao_hr_work_profiles (workspace_id, dao_slug, manager_person_id)
  WHERE manager_person_id IS NOT NULL;

ALTER TABLE harness_shared.dao_hr_work_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dao_hr_work_profiles_workspace_isolation
  ON harness_shared.dao_hr_work_profiles;
CREATE POLICY dao_hr_work_profiles_workspace_isolation
  ON harness_shared.dao_hr_work_profiles FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.dao_hr_work_profiles TO harness_app, harness_admin;

COMMENT ON TABLE harness_shared.dao_hr_work_profiles IS
  'DAO HR work profile per (workspace, DAO, person). person_id is the canonical PER- person record (harness_shared.work_items, item_kind=person); contact data lives ONLY there (dao-hr-people-2026-10-11 R-1). Writer: packages/operator-core/lib/dao-hr/work-profile.ts.';
