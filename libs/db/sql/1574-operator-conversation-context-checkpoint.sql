-- Shared context state stays with the existing conversation. The journal is
-- independent of the checkpoint CAS so a lost summary write cannot lose spend.
ALTER TABLE harness_shared.operator_conversations
  ADD COLUMN IF NOT EXISTS context_state JSONB;

COMMENT ON COLUMN harness_shared.operator_conversations.context_state IS
  'Versioned shared ConversationContext checkpoint and idempotent housekeeping receipts; credentials are never stored here.';
