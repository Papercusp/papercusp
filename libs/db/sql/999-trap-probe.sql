DO $mig$
DECLARE s text;
BEGIN
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname LIKE 'harness\_%' LOOP
    EXECUTE format('ALTER VIEW %I.agent_chats ALTER COLUMN workspace_id SET DEFAULT %L', s, 'default');
  END LOOP;
END
$mig$;
