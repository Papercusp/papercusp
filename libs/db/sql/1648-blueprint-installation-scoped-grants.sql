-- P002/D009: extend the existing installation source; no parallel grant store.
-- FORWARD-COMPAT: nullable additive column; old writers leave scopes unknown.
-- Source provenance is not permission-change admission or edit authority.
ALTER TABLE harness_shared.blueprint_package_installations
  ADD COLUMN IF NOT EXISTS scoped_grants jsonb;

CREATE FUNCTION harness_shared.blueprint_installation_scoped_grants_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE layer jsonb; rule jsonb; pattern jsonb; category text; seen text[] := '{}';
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR value->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR value - ARRAY['schemaVersion','layers'] <> '{}'::jsonb
    OR jsonb_typeof(value->'layers') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value->'layers') > 256 THEN RETURN false; END IF;
  FOR layer IN SELECT jsonb_array_elements(value->'layers') LOOP
    IF jsonb_typeof(layer) IS DISTINCT FROM 'object'
      OR layer - ARRAY['layerRef','layerContentHash','grants'] <> '{}'::jsonb
      OR jsonb_typeof(layer->'layerRef') IS DISTINCT FROM 'string'
      OR length(layer->>'layerRef') NOT BETWEEN 1 AND 4096
      OR btrim(layer->>'layerRef') <> (layer->>'layerRef')
      OR (layer->>'layerRef') ~ '[[:cntrl:]]'
      OR (layer->>'layerRef') = ANY(seen)
      OR jsonb_typeof(layer->'layerContentHash') IS DISTINCT FROM 'string'
      OR ((layer->>'layerContentHash') ~ '^[a-f0-9]{64}$') IS NOT TRUE
      OR jsonb_typeof(layer->'grants') IS DISTINCT FROM 'object'
      OR (layer->'grants') - ARRAY['actions','resources'] <> '{}'::jsonb THEN RETURN false; END IF;
    seen := array_append(seen, layer->>'layerRef');
    FOREACH category IN ARRAY ARRAY['actions','resources'] LOOP
      rule := layer->'grants'->category;
      IF jsonb_typeof(rule) IS DISTINCT FROM 'object'
        OR rule - ARRAY['allow','deny'] <> '{}'::jsonb
        OR jsonb_typeof(rule->'allow') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      IF jsonb_array_length(rule->'allow') > 4096 THEN RETURN false; END IF;
      IF rule ? 'deny' THEN
        IF jsonb_typeof(rule->'deny') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
        IF jsonb_array_length(rule->'deny') > 4096 THEN RETURN false; END IF;
      END IF;
      FOR pattern IN SELECT jsonb_array_elements((rule->'allow') || coalesce(rule->'deny', '[]'::jsonb)) LOOP
        IF jsonb_typeof(pattern) IS DISTINCT FROM 'string'
          OR length(pattern #>> '{}') NOT BETWEEN 1 AND 4096
          OR btrim(pattern #>> '{}') <> (pattern #>> '{}')
          OR (pattern #>> '{}') ~ '[[:cntrl:]]' THEN RETURN false; END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN true;
END;
$$;

ALTER TABLE harness_shared.blueprint_package_installations
  ADD CONSTRAINT blueprint_installation_scoped_grants_shape CHECK (scoped_grants IS NULL OR (
    human_ownership IS NOT NULL AND harness_shared.blueprint_installation_scoped_grants_valid(scoped_grants)
  ) IS TRUE);

CREATE FUNCTION harness_shared.guard_blueprint_installation_scoped_grants() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scoped_grants IS DISTINCT FROM OLD.scoped_grants THEN
    RAISE EXCEPTION 'package installation scoped grants are immutable per attempt';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER blueprint_installation_scoped_grants_immutable
  BEFORE UPDATE OF scoped_grants ON harness_shared.blueprint_package_installations
  FOR EACH ROW EXECUTE FUNCTION harness_shared.guard_blueprint_installation_scoped_grants();
