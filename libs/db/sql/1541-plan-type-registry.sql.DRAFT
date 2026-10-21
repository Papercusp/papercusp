-- plan-item-types-registry-cupboard-2026-10-20 P-001 (WI-6554700010018623): the item-type and
-- plan-type definition registry.
--
-- An ITEM TYPE defines one kind of plan step: the verification modules it is held to, its
-- completion fields and its criteria. A PLAN TYPE declares the item types it uses, its base,
-- its acceptance classes and its default item type (D-001). Both are revisioned. A plan pins the
-- revisions it resolved at activation (P-005), so a published revision never re-grades it.
--
-- First-party definitions (the `papercusp/` namespace: the six built-in deliverable kinds and
-- the coding/general plan types) live in code, in packages/operator-core/lib/plan-types/
-- builtin-catalog.ts. A workspace created at any time therefore resolves them without per-
-- workspace seed rows. These tables hold only workspace-authored and pack-installed definitions,
-- and the `papercusp/` namespace is reserved by a CHECK so a row can never shadow a built-in.
--
-- hive_slug NULL means the definition applies to the whole workspace; a hive row narrows it.
--
-- FORWARD-COMPAT: both tables are new and have no writer in the currently deployed release, so
-- their CHECKs and unique indexes cannot reject a write that release makes.

CREATE TABLE IF NOT EXISTS harness_shared.plan_item_type_definitions (
  id                bigserial   PRIMARY KEY,
  workspace_id      text        NOT NULL,
  hive_slug         text,
  type_id           text        NOT NULL,
  revision          integer     NOT NULL CHECK (revision >= 1),
  definition        jsonb       NOT NULL,
  origin            text        NOT NULL CHECK (origin IN ('workspace', 'pack')),
  source_listing_id text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,
  retired_at        timestamptz,
  retired_by        text,
  retire_reason     text,
  CONSTRAINT plan_item_type_definitions_id_grammar
    CHECK (type_id ~ '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$'),
  CONSTRAINT plan_item_type_definitions_first_party_reserved
    CHECK (type_id NOT LIKE 'papercusp/%'),
  CONSTRAINT plan_item_type_definitions_definition_matches_row
    CHECK (
      jsonb_typeof(definition) = 'object'
      AND definition->>'schemaVersion' = '1'
      AND definition->>'id' = type_id
      AND definition->>'revision' = revision::text
    ),
  CONSTRAINT plan_item_type_definitions_pack_provenance
    CHECK (origin <> 'pack' OR source_listing_id IS NOT NULL),
  CONSTRAINT plan_item_type_definitions_retire_reason
    CHECK (retired_at IS NULL OR retire_reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_item_type_definitions_revision_key
  ON harness_shared.plan_item_type_definitions (workspace_id, COALESCE(hive_slug, ''), type_id, revision);
ALTER TABLE harness_shared.plan_item_type_definitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_item_type_definitions_workspace_isolation ON harness_shared.plan_item_type_definitions;
CREATE POLICY plan_item_type_definitions_workspace_isolation
  ON harness_shared.plan_item_type_definitions FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE ON harness_shared.plan_item_type_definitions TO harness_app, harness_admin;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.plan_item_type_definitions_id_seq TO harness_app, harness_admin;
COMMENT ON TABLE harness_shared.plan_item_type_definitions IS
  'Revisioned plan item-type definitions authored in a workspace or installed from a Cupboard pack. First-party papercusp/* item types live in code (plan-types/builtin-catalog.ts). plan-item-types-registry-cupboard-2026-10-20 P-001.';

CREATE TABLE IF NOT EXISTS harness_shared.plan_type_definitions (
  id                bigserial   PRIMARY KEY,
  workspace_id      text        NOT NULL,
  hive_slug         text,
  type_id           text        NOT NULL,
  revision          integer     NOT NULL CHECK (revision >= 1),
  definition        jsonb       NOT NULL,
  origin            text        NOT NULL CHECK (origin IN ('workspace', 'pack')),
  source_listing_id text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,
  retired_at        timestamptz,
  retired_by        text,
  retire_reason     text,
  CONSTRAINT plan_type_definitions_id_grammar
    CHECK (type_id ~ '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$'),
  CONSTRAINT plan_type_definitions_first_party_reserved
    CHECK (type_id NOT LIKE 'papercusp/%'),
  CONSTRAINT plan_type_definitions_definition_matches_row
    CHECK (
      jsonb_typeof(definition) = 'object'
      AND definition->>'schemaVersion' = '1'
      AND definition->>'id' = type_id
      AND definition->>'revision' = revision::text
    ),
  CONSTRAINT plan_type_definitions_pack_provenance
    CHECK (origin <> 'pack' OR source_listing_id IS NOT NULL),
  CONSTRAINT plan_type_definitions_retire_reason
    CHECK (retired_at IS NULL OR retire_reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS plan_type_definitions_revision_key
  ON harness_shared.plan_type_definitions (workspace_id, COALESCE(hive_slug, ''), type_id, revision);
ALTER TABLE harness_shared.plan_type_definitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_type_definitions_workspace_isolation ON harness_shared.plan_type_definitions;
CREATE POLICY plan_type_definitions_workspace_isolation
  ON harness_shared.plan_type_definitions FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE ON harness_shared.plan_type_definitions TO harness_app, harness_admin;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.plan_type_definitions_id_seq TO harness_app, harness_admin;
COMMENT ON TABLE harness_shared.plan_type_definitions IS
  'Revisioned plan-type definitions authored in a workspace or installed from a Cupboard pack. First-party papercusp/* plan types live in code (plan-types/builtin-catalog.ts). plan-item-types-registry-cupboard-2026-10-20 P-001.';
