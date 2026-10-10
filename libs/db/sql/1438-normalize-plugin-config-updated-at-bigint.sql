-- 1438-normalize-plugin-config-updated-at-bigint.sql
--
-- The plugin-config mirror writer and the SQL baseline use epoch-millisecond
-- BIGINT values for updated_at. Some databases retained a pre-existing
-- TIMESTAMPTZ column because the baseline's CREATE/ADD COLUMN IF NOT EXISTS
-- statements do not normalize an existing column type. Convert those legacy
-- values without losing their represented instant; leave databases already
-- on the canonical BIGINT type unchanged.
DO $$
DECLARE
  current_type text;
BEGIN
  SELECT data_type
    INTO current_type
    FROM information_schema.columns
   WHERE table_schema = 'harness_shared'
     AND table_name = 'plugin_configs'
     AND column_name = 'updated_at';

  IF current_type = 'timestamp with time zone' THEN
    ALTER TABLE harness_shared.plugin_configs
      ALTER COLUMN updated_at DROP DEFAULT;
    ALTER TABLE harness_shared.plugin_configs
      ALTER COLUMN updated_at TYPE bigint
      USING floor(extract(epoch FROM updated_at) * 1000)::bigint;
    ALTER TABLE harness_shared.plugin_configs
      ALTER COLUMN updated_at SET DEFAULT 0;
  ELSIF current_type = 'bigint' THEN
    ALTER TABLE harness_shared.plugin_configs
      ALTER COLUMN updated_at SET DEFAULT 0;
  ELSE
    RAISE EXCEPTION
      'Expected harness_shared.plugin_configs.updated_at to be timestamptz or bigint; found %',
      coalesce(current_type, '<missing>');
  END IF;
END
$$;
