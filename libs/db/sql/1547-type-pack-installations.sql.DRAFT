-- plan-item-types-registry-cupboard-2026-10-20 P-006 (WI-6554700010018628), D-008: install receipts
-- for Cupboard type packs (a `pack` listing whose manifest carries item types and/or plan types).
--
-- harness_shared.type_pack_installations holds one row per (workspace, listing). The row is the
-- provenance pin the install verified: the listing id, the pack name and version, the commit sha
-- and tree digest the content was fetched and checked at, and the release content hash when the
-- listing carried one. It also records what the install placed or relied on, each with its
-- content hash: the item-type and plan-type revisions, the rubrics and datatypes it co-installed
-- (or found already present), and how every item-type reference resolved (same pack, registry or
-- another pack's listing). The install writes the receipt in the same transaction as the
-- definitions, so a refused install leaves no receipt.
--
-- trigger_pack_installations is not reused: it is harness-scoped and carries a configuration
-- lifecycle, whereas type definitions are workspace registry rows.
--
-- FORWARD-COMPAT: additive only. A new table that the deployed release never reads or writes.

CREATE TABLE IF NOT EXISTS harness_shared.type_pack_installations (
  id                    bigserial   PRIMARY KEY,
  workspace_id          text        NOT NULL,
  listing_id            text        NOT NULL,
  pack_name             text        NOT NULL,
  pack_version          text        NOT NULL,
  commit_sha            text        NOT NULL,
  tree_digest           text        NOT NULL,
  release_content_hash  text,
  item_types            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  plan_types            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  rubrics               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  datatypes             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  dependencies          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  installed_by          text        NOT NULL,
  installed_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT type_pack_installations_listing_key UNIQUE (workspace_id, listing_id),
  CONSTRAINT type_pack_installations_names_nonempty
    CHECK (btrim(listing_id) <> '' AND btrim(pack_name) <> '' AND btrim(pack_version) <> ''),
  CONSTRAINT type_pack_installations_commit_sha_shape
    CHECK (commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  CONSTRAINT type_pack_installations_tree_digest_shape
    CHECK (tree_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT type_pack_installations_arrays CHECK (
    jsonb_typeof(item_types) = 'array' AND jsonb_typeof(plan_types) = 'array'
    AND jsonb_typeof(rubrics) = 'array' AND jsonb_typeof(datatypes) = 'array'
    AND jsonb_typeof(dependencies) = 'array'),
  CONSTRAINT type_pack_installations_carries_types
    CHECK (jsonb_array_length(item_types) + jsonb_array_length(plan_types) > 0)
);
ALTER TABLE harness_shared.type_pack_installations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS type_pack_installations_workspace_isolation ON harness_shared.type_pack_installations;
CREATE POLICY type_pack_installations_workspace_isolation
  ON harness_shared.type_pack_installations FOR ALL TO public
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE ON harness_shared.type_pack_installations TO harness_app, harness_admin;
GRANT USAGE, SELECT ON SEQUENCE harness_shared.type_pack_installations_id_seq TO harness_app, harness_admin;
COMMENT ON TABLE harness_shared.type_pack_installations IS
  'Install receipts for Cupboard type packs: the provenance pin (listing, commit sha, tree digest, release hash) and every definition, rubric, datatype and resolved dependency the install placed, with content hashes. plan-item-types-registry-cupboard-2026-10-20 P-006 (D-008).';
