-- plan-item-types-registry-cupboard-2026-10-20 P-005 (WI-6554700010018627), D-006: plans pin the
-- type revisions they resolved, and a stored definition revision never changes.
--
-- 1. harness_shared.plan_type_pins: one row per type a plan resolves (its plan type, every item
--    type, and every parent reached through `extends`), keyed by plan and type id. The row holds
--    the revision and the content hash the plan resolved. A pinned plan resolves exactly that
--    revision, retired or not; a definition whose content no longer matches its pin fails safe to
--    the strictest module set. Pins are written when a plan activates and when an activated plan
--    first references a new type (insert-if-absent). Only plan-types:pin changes an existing pin.
--
-- 2. A BEFORE UPDATE trigger on both definition tables refuses any change to a stored revision
--    except retiring it, once. A new rule is a new revision, so a pin can never be re-pointed at
--    different content behind the plan's back. DELETE is allowed (workspace purge): a pin whose
--    revision is gone resolves to the strictest set, which never lowers a plan's checks.
--
-- 3. Backfill: every plan already activated (status ready, active, awaiting-acceptance or
--    shipped; ACTIVATED_PLAN_STATUSES in plan-verification-escape.ts) is pinned to the eight
--    first-party definitions at revision 1. The hashes are the literals that
--    plan-types/content-hash.test.ts fixes for BUILTIN_CATALOG. Over-pinning is harmless: a pin
--    only matters for a type the plan resolves.
--
-- FORWARD-COMPAT: additive only. plan_type_pins is new and the deployed release never writes the
-- two definition tables, so the new trigger cannot refuse a write that release makes.

CREATE TABLE IF NOT EXISTS harness_shared.plan_type_pins (
  workspace_id  text        NOT NULL,
  harness_slug  text        NOT NULL,
  plan_slug     text        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('item-type', 'plan-type')),
  type_id       text        NOT NULL,
  revision      integer     NOT NULL CHECK (revision >= 1),
  content_hash  text        NOT NULL,
  pinned_at     timestamptz NOT NULL DEFAULT now(),
  pinned_by     text        NOT NULL,
  pin_reason    text,
  CONSTRAINT plan_type_pins_pkey PRIMARY KEY (workspace_id, harness_slug, plan_slug, kind, type_id),
  CONSTRAINT plan_type_pins_id_grammar
    CHECK (type_id ~ '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$'),
  CONSTRAINT plan_type_pins_content_hash_shape
    CHECK (content_hash ~ '^[0-9a-f]{64}$')
);
ALTER TABLE harness_shared.plan_type_pins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plan_type_pins_workspace_isolation ON harness_shared.plan_type_pins;
CREATE POLICY plan_type_pins_workspace_isolation
  ON harness_shared.plan_type_pins FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE ON harness_shared.plan_type_pins TO harness_app, harness_admin;
COMMENT ON TABLE harness_shared.plan_type_pins IS
  'The item-type and plan-type revisions each activated plan resolved, keyed by id, revision and content hash, so a later revision never re-grades the plan. plan-item-types-registry-cupboard-2026-10-20 P-005 (D-006).';

CREATE OR REPLACE FUNCTION harness_shared.plan_type_definition_revision_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.hive_slug IS DISTINCT FROM OLD.hive_slug
     OR NEW.type_id IS DISTINCT FROM OLD.type_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.definition IS DISTINCT FROM OLD.definition
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.source_listing_id IS DISTINCT FROM OLD.source_listing_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'type definition % revision % is immutable; define a new revision instead (%)',
      OLD.type_id, OLD.revision, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.retired_at IS NOT NULL
     AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at
          OR NEW.retired_by IS DISTINCT FROM OLD.retired_by
          OR NEW.retire_reason IS DISTINCT FROM OLD.retire_reason) THEN
    RAISE EXCEPTION 'type definition % revision % is already retired; a retirement cannot be changed (%)',
      OLD.type_id, OLD.revision, TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS plan_item_type_definitions_revision_immutable ON harness_shared.plan_item_type_definitions;
CREATE TRIGGER plan_item_type_definitions_revision_immutable
  BEFORE UPDATE ON harness_shared.plan_item_type_definitions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.plan_type_definition_revision_immutable();

DROP TRIGGER IF EXISTS plan_type_definitions_revision_immutable ON harness_shared.plan_type_definitions;
CREATE TRIGGER plan_type_definitions_revision_immutable
  BEFORE UPDATE ON harness_shared.plan_type_definitions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.plan_type_definition_revision_immutable();

INSERT INTO harness_shared.plan_type_pins
  (workspace_id, harness_slug, plan_slug, kind, type_id, revision, content_hash, pinned_by, pin_reason)
SELECT p.workspace_id, p.harness_slug, p.plan_slug, t.kind, t.type_id, 1, t.content_hash,
       'migration:1545',
       'activated before the type registry: pinned to the first-party revision'
  FROM harness_shared.harness_plans p
 CROSS JOIN (VALUES
   ('item-type', 'papercusp/code',      'b3845721014d94609a14b7076381cc25e033979c00d077620ede2fd7da8d63a8'),
   ('item-type', 'papercusp/doc',       '03961bf29818a0811a1be0714ea416d707dcbda53ff03ebcd849a3b8d9a2ff10'),
   ('item-type', 'papercusp/decision',  'b4b4381dbcdacf850fc06c4c972f3e91c9edda6fa5ecb5bb4092fa984381db33'),
   ('item-type', 'papercusp/research',  '01f4fe2ffe230eb3f4e4185841bb63f59f1d9e19c9d552e972cb7c34e113c48f'),
   ('item-type', 'papercusp/operation', '3248c2c0a553462bf8fc542131c12a2be87d2a5e6807a96eafba4e7ffd97c82a'),
   ('item-type', 'papercusp/artifact',  'bab794a1a29e1e663be6659bf5bcec54fe687a9f62375507f9157d2e74448d80'),
   ('plan-type', 'papercusp/coding',    '1a12288396d2c39c6169e92eb7a50a882e9612172b6bcd45bbb4286e70c3e1cf'),
   ('plan-type', 'papercusp/general',   '7caa0494d37bce4d8e64c310853c03a9059edca6daf4bfa4265f4ceca77ced37')
 ) AS t(kind, type_id, content_hash)
 WHERE p.status IN ('ready', 'active', 'awaiting-acceptance', 'shipped')
   AND p.workspace_id IS NOT NULL
   AND p.harness_slug IS NOT NULL
   AND p.plan_slug IS NOT NULL
ON CONFLICT DO NOTHING;
