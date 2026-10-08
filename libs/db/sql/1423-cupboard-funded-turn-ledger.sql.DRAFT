-- P-017 / WI-10004281, D-043: LOCAL monetary turn history, never a funding authority.
-- Hosted signed reservations remain authoritative. One unresolved turn per exact
-- payer/offer prevents fractional remainder races; historical native turn keys
-- prevent re-entry after carry/restart. No existing data is changed.
CREATE TABLE IF NOT EXISTS harness_shared.cupboard_metered_accounts (
  workspace_id text NOT NULL CHECK (length(btrim(workspace_id)) > 0),
  account_id text NOT NULL CHECK (account_id ~ '^[a-f0-9]{64}$'),
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  remainder_numerator integer NOT NULL DEFAULT 0 CHECK (remainder_numerator BETWEEN 0 AND 9999),
  active_turn_id text CHECK (active_turn_id ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, account_id)
);

CREATE TABLE IF NOT EXISTS harness_shared.cupboard_funded_turns (
  workspace_id text NOT NULL,
  turn_id text NOT NULL CHECK (turn_id ~ '^[a-f0-9]{64}$'),
  account_id text NOT NULL,
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  binding jsonb NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN
    ('prepared', 'funded', 'running', 'closed', 'settlement-pending', 'settled')),
  funding_receipt jsonb CHECK (jsonb_typeof(funding_receipt) = 'object'),
  usage_event_keys jsonb CHECK (jsonb_typeof(usage_event_keys) = 'array'),
  closed_at_ms bigint CHECK (closed_at_ms BETWEEN 0 AND 9007199254740991),
  settlement_outbox jsonb CHECK (jsonb_typeof(settlement_outbox) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, turn_id),
  FOREIGN KEY (workspace_id, account_id)
    REFERENCES harness_shared.cupboard_metered_accounts (workspace_id, account_id),
  CHECK ((state = 'prepared') = (funding_receipt IS NULL)),
  CHECK ((state IN ('prepared', 'funded', 'running')) = (usage_event_keys IS NULL)),
  CHECK ((usage_event_keys IS NULL) = (closed_at_ms IS NULL)),
  CHECK (usage_event_keys IS NULL OR jsonb_array_length(usage_event_keys) BETWEEN 1 AND 1000),
  CHECK ((state IN ('settlement-pending', 'settled')) = (settlement_outbox IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS cupboard_funded_turns_pending
  ON harness_shared.cupboard_funded_turns (workspace_id, updated_at)
  WHERE state <> 'settled';

COMMENT ON TABLE harness_shared.cupboard_funded_turns IS
  'Local P-017 native-turn admission/CAS and signed settlement outbox; prepared rows and cached receipts grant no hosted funding authority. Native turn history is retained across restarts.';
COMMENT ON TABLE harness_shared.cupboard_metered_accounts IS
  'Local P-017 exact payer/offer binding and fractional markup numerator. Remainder advances only on verified hosted settlement acknowledgement.';

ALTER TABLE harness_shared.cupboard_metered_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_shared.cupboard_funded_turns ENABLE ROW LEVEL SECURITY;
