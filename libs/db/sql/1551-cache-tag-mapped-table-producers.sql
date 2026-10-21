-- Migration 1551 — change notifications for four newly mapped cache-tag tables.
-- WI-6554700010019121: these low-churn state tables back live learning and
-- network-directory queries, but had no sync_invalidate producer for raw or
-- federated writes. pot_policy's substrate outbox triggers only replicate
-- policy changes; they do not invalidate the sync query. event_awaits is
-- intentionally excluded because migration 1546 supplies its filtered
-- emit_event_await_change_notify producer (inbox-wake rows must stay quiet).
--
-- Idempotent and defensive for partial databases, following migration 636.

DO $$
DECLARE
  table_name text;
  tables text[] := ARRAY[
    'gym_autoloop_config',
    'learning_spend_reservations',
    'operator_gym_gates',
    'pot_policy'
  ];
BEGIN
  FOREACH table_name IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared'
         AND c.relname = table_name
         AND c.relkind = 'r'
    ) THEN
      EXECUTE format(
        'CREATE OR REPLACE TRIGGER emit_change_notify_trg '
        || 'AFTER INSERT OR UPDATE OR DELETE ON harness_shared.%I '
        || 'FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify()',
        table_name
      );
    END IF;
  END LOOP;
END $$;
