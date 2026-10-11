-- 1445 — independent verification of live/deployed evidence.
-- verification-system-improvements-2026-10-10 P-008 (D-005; refusal code per D-015 point 4).
--
-- A mandatory outcome bar on the live or deployed plane must carry evidence bound by
-- someone OUTSIDE the implementers' spawn/rebind lineage. That evidence is a new
-- evidence kind, 'independent-verification', which always CITES the implementer
-- binding it re-observed (verifies_binding_id). The store refuses the binding when its
-- source or environment fingerprint differs from the cited row; the ship gate refuses
-- with independent_verification_missing when no lineage-independent row exists.
--
-- FORWARD-COMPAT: dropping and re-adding spec_evidence_bindings_evidence_kind_check only
-- WIDENS the allowed set (adds 'independent-verification'); the currently deployed
-- release never writes that kind, and every value it does write stays valid. The new
-- column is nullable and the paired CHECK holds for every existing row (no existing row
-- has the new kind, and all have verifies_binding_id NULL).

ALTER TABLE harness_shared.spec_evidence_bindings
  ADD COLUMN IF NOT EXISTS verifies_binding_id bigint
    REFERENCES harness_shared.spec_evidence_bindings (id);

COMMENT ON COLUMN harness_shared.spec_evidence_bindings.verifies_binding_id IS
  'P-008: for evidence_kind=independent-verification, the implementer binding this row '
  're-observed. Required for that kind and forbidden for every other kind.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'spec_evidence_bindings_evidence_kind_check'
       AND conrelid = 'harness_shared.spec_evidence_bindings'::regclass
       AND pg_get_constraintdef(oid) NOT LIKE '%independent-verification%'
  ) THEN
    ALTER TABLE harness_shared.spec_evidence_bindings
      DROP CONSTRAINT spec_evidence_bindings_evidence_kind_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'spec_evidence_bindings_evidence_kind_check'
       AND conrelid = 'harness_shared.spec_evidence_bindings'::regclass
  ) THEN
    ALTER TABLE harness_shared.spec_evidence_bindings
      ADD CONSTRAINT spec_evidence_bindings_evidence_kind_check
      CHECK (evidence_kind IN (
        'test', 'fixture', 'coverage-census', 'mutation', 'counterexample',
        'check', 'manual', 'operational', 'independent-verification'
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'spec_evidence_bindings_verifies_binding_check'
       AND conrelid = 'harness_shared.spec_evidence_bindings'::regclass
  ) THEN
    ALTER TABLE harness_shared.spec_evidence_bindings
      ADD CONSTRAINT spec_evidence_bindings_verifies_binding_check
      CHECK ((evidence_kind = 'independent-verification') = (verifies_binding_id IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS spec_evidence_bindings_by_verified_binding
  ON harness_shared.spec_evidence_bindings (verifies_binding_id)
  WHERE verifies_binding_id IS NOT NULL;
