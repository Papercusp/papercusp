-- P002: extend the installation journal; technical owner_id stays a wearer/pot.
-- FORWARD-COMPAT: nullable additive column, no inferred/backfilled human owners.
-- Old readers/writers keep working; omitted declarations stay unknown.
ALTER TABLE harness_shared.blueprint_package_installations
  ADD COLUMN IF NOT EXISTS human_ownership jsonb;

ALTER TABLE harness_shared.blueprint_package_installations
  ADD CONSTRAINT blueprint_installation_human_ownership_shape CHECK (human_ownership IS NULL OR (
    jsonb_typeof(human_ownership) = 'object'
    AND human_ownership->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof(human_ownership->'declaration') = 'string'
    AND jsonb_typeof(human_ownership->'authMethod') = 'string'
    AND jsonb_typeof(human_ownership->'workspaceId') = 'string'
    AND jsonb_typeof(human_ownership->'ownerId') = 'string'
    AND jsonb_typeof(human_ownership->'specificationRevision') = 'string'
    AND jsonb_typeof(human_ownership->'principalRevision') = 'string'
    AND human_ownership->>'declaration' = 'self'
    AND human_ownership->>'authMethod' = 'cookie-session'
    AND human_ownership->>'workspaceId' = workspace_id
    AND human_ownership->>'ownerId' = owner_id
    AND human_ownership->>'specificationRevision' = specification_revision
    AND jsonb_typeof(human_ownership->'userId') = 'string'
    AND length(btrim(human_ownership->>'userId')) > 0
    AND human_ownership->>'userId' <> '*'
    AND human_ownership->>'specificationRevision' ~ '^[a-f0-9]{64}$'
    AND human_ownership->>'principalRevision' ~ '^[a-f0-9]{64}$'
    AND human_ownership - ARRAY['schemaVersion','declaration','authMethod','workspaceId','ownerId',
      'userId','specificationRevision','principalRevision'] = '{}'::jsonb
  ) IS TRUE);

CREATE FUNCTION harness_shared.guard_blueprint_installation_human_ownership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.human_ownership IS DISTINCT FROM OLD.human_ownership THEN
    RAISE EXCEPTION 'package installation human ownership is immutable per attempt';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER blueprint_installation_human_ownership_immutable
  BEFORE UPDATE OF human_ownership ON harness_shared.blueprint_package_installations
  FOR EACH ROW EXECUTE FUNCTION harness_shared.guard_blueprint_installation_human_ownership();
