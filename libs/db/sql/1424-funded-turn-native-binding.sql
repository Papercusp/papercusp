-- P-017 / WI-10004281, D-047. Extend the existing local monetary ledger.
-- Before inference an explicit admissionId retains the reservation; only the
-- correlated backend response supplies nativeTurnId. Unknown delivery remains
-- held. Legacy native-turn nonce identities and funding receipts are unchanged.
-- FORWARD-COMPAT: the legacy producer already hashes workspace/session/native
-- turn/offer into the primary key, so this index preserves its existing unique
-- identity contract. Its validated bindings always have a nonempty native ID.
-- New pre-inference admissions have a distinct admission nonce and a null
-- native ID until the backend response is durably bound; only these new rows
-- can introduce another candidate for the legacy native identity tuple.
CREATE UNIQUE INDEX IF NOT EXISTS cupboard_funded_turns_native_identity
  ON harness_shared.cupboard_funded_turns
    (workspace_id, (binding->>'nativeSessionId'), (binding->>'nativeTurnId'), (binding->>'offerId'))
  WHERE binding->>'nativeTurnId' IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'harness_shared.cupboard_funded_turns'::regclass
        AND conname = 'cupboard_funded_turns_native_binding') THEN
    ALTER TABLE harness_shared.cupboard_funded_turns
      ADD CONSTRAINT cupboard_funded_turns_native_binding CHECK (
        NULLIF(btrim(binding->>'nativeTurnId'), '') IS NOT NULL
        OR (NULLIF(btrim(binding->>'admissionId'), '') IS NOT NULL
            AND state IN ('prepared', 'funded', 'running'))
      );
  END IF;
END $$;
