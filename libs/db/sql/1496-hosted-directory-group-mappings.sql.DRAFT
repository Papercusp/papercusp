-- WI-10007899 / enterprise readiness P-004: supported directory ingestion,
-- approved group-role mappings and delegated directory provisioning.
--
-- Authority model (extends 903 D-067; nothing here lets a webhook GRANT):
--   * directory_user_observations are ingested provider FACTS (WorkOS
--     Directory Sync user state + group membership). They are never authority:
--     no row here creates, elevates or reactivates a membership by itself.
--   * directory_group_role_mappings are customer-administrator APPROVALS of
--     "members of directory group G may be provisioned with role R". Owners may
--     approve admin|member|billing; admins only member|billing; never owner.
--   * provision_directory_membership() is the only new INSERT path into
--     organization_memberships. It runs as hosted_owner (hosted_service keeps
--     its reduction-only grant from 978) and re-validates the acting
--     administrator inside the same transaction. It never touches an existing
--     membership row, so it cannot elevate or reactivate anyone.

CREATE TABLE IF NOT EXISTS papercusp_auth.directory_group_role_mappings (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid        NOT NULL REFERENCES papercusp_auth.organizations(id),
  directory_id        text        NOT NULL,
  group_id            text        NOT NULL,
  role                text        NOT NULL,
  status              text        NOT NULL DEFAULT 'active',
  approved_by_user_id uuid        NOT NULL,
  approved_at         timestamptz NOT NULL DEFAULT now(),
  removed_by_user_id  uuid,
  removed_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT directory_group_role_mappings_role_ck
    CHECK (role IN ('admin', 'member', 'billing')),
  CONSTRAINT directory_group_role_mappings_status_ck
    CHECK (status IN ('active', 'removed')),
  CONSTRAINT directory_group_role_mappings_removed_ck
    CHECK ((status = 'removed') = (removed_at IS NOT NULL)),
  CONSTRAINT directory_group_role_mappings_ids_ck
    CHECK (length(btrim(directory_id)) BETWEEN 1 AND 512 AND length(btrim(group_id)) BETWEEN 1 AND 512),
  CONSTRAINT directory_group_role_mappings_key
    UNIQUE (organization_id, directory_id, group_id)
);

COMMENT ON TABLE papercusp_auth.directory_group_role_mappings IS
  'Customer-administrator approvals that members of one directory group may be provisioned with one non-owner role (WI-10007899). Approval only; provisioning is a separate explicit administrator action.';

CREATE TABLE IF NOT EXISTS papercusp_auth.directory_user_observations (
  external_organization_id text        NOT NULL,
  directory_id             text        NOT NULL,
  directory_user_id        text        NOT NULL,
  state                    text        NOT NULL DEFAULT 'unknown',
  groups                   text[]      NOT NULL DEFAULT ARRAY[]::text[],
  first_observed_at        timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (external_organization_id, directory_id, directory_user_id),
  CONSTRAINT directory_user_observations_state_ck
    CHECK (state IN ('unknown', 'active', 'inactive')),
  CONSTRAINT directory_user_observations_groups_ck
    CHECK (cardinality(groups) <= 1000)
);

COMMENT ON TABLE papercusp_auth.directory_user_observations IS
  'Ingested WorkOS Directory Sync facts (user state + group membership), cursor-ordered by the lifecycle worker. Never authority: a row grants nothing on its own (WI-10007899).';

ALTER TABLE papercusp_auth.directory_group_role_mappings OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.directory_user_observations OWNER TO hosted_owner;
ALTER TABLE papercusp_auth.directory_group_role_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.directory_group_role_mappings FORCE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.directory_user_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE papercusp_auth.directory_user_observations FORCE ROW LEVEL SECURITY;

REVOKE ALL ON papercusp_auth.directory_group_role_mappings,
  papercusp_auth.directory_user_observations
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON papercusp_auth.directory_group_role_mappings,
  papercusp_auth.directory_user_observations
TO hosted_service;

DROP POLICY IF EXISTS directory_group_role_mappings_service_select ON papercusp_auth.directory_group_role_mappings;
CREATE POLICY directory_group_role_mappings_service_select ON papercusp_auth.directory_group_role_mappings
  FOR SELECT TO hosted_service USING (true);
DROP POLICY IF EXISTS directory_group_role_mappings_service_insert ON papercusp_auth.directory_group_role_mappings;
CREATE POLICY directory_group_role_mappings_service_insert ON papercusp_auth.directory_group_role_mappings
  FOR INSERT TO hosted_service WITH CHECK (true);
DROP POLICY IF EXISTS directory_group_role_mappings_service_update ON papercusp_auth.directory_group_role_mappings;
CREATE POLICY directory_group_role_mappings_service_update ON papercusp_auth.directory_group_role_mappings
  FOR UPDATE TO hosted_service USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS directory_user_observations_service_select ON papercusp_auth.directory_user_observations;
CREATE POLICY directory_user_observations_service_select ON papercusp_auth.directory_user_observations
  FOR SELECT TO hosted_service USING (true);
DROP POLICY IF EXISTS directory_user_observations_service_insert ON papercusp_auth.directory_user_observations;
CREATE POLICY directory_user_observations_service_insert ON papercusp_auth.directory_user_observations
  FOR INSERT TO hosted_service WITH CHECK (true);
DROP POLICY IF EXISTS directory_user_observations_service_update ON papercusp_auth.directory_user_observations;
CREATE POLICY directory_user_observations_service_update ON papercusp_auth.directory_user_observations
  FOR UPDATE TO hosted_service USING (true) WITH CHECK (true);

-- The caller (hosted_service) has already locked the organization and the
-- acting membership FOR SHARE in this transaction; the checks below repeat the
-- authority rule at the privileged boundary so a caller bug cannot widen it.
CREATE OR REPLACE FUNCTION papercusp_auth.provision_directory_membership(
  p_organization_id uuid,
  p_user_id uuid,
  p_role text,
  p_actor_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, papercusp_auth
AS $function$
DECLARE
  v_actor_role text;
  v_id uuid;
BEGIN
  IF p_organization_id IS NULL OR p_user_id IS NULL OR p_actor_user_id IS NULL OR p_role IS NULL THEN
    RAISE EXCEPTION 'directory_provision_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_role NOT IN ('admin', 'member', 'billing') THEN
    RAISE EXCEPTION 'directory_provision_forbidden_role' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = p_actor_user_id THEN
    RAISE EXCEPTION 'directory_provision_forbidden' USING ERRCODE = '42501';
  END IF;
  SELECT m.role INTO v_actor_role
    FROM papercusp_auth.organization_memberships AS m
   WHERE m.organization_id = p_organization_id
     AND m.user_id = p_actor_user_id
     AND m.status = 'active';
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'directory_provision_forbidden' USING ERRCODE = '42501';
  END IF;
  IF v_actor_role = 'admin' AND p_role NOT IN ('member', 'billing') THEN
    RAISE EXCEPTION 'directory_provision_forbidden_role' USING ERRCODE = '42501';
  END IF;
  -- Any existing row, whatever its status, is out of scope: provisioning never
  -- elevates an active member and never reactivates a suspended/revoked one.
  IF EXISTS (
    SELECT 1 FROM papercusp_auth.organization_memberships AS m
     WHERE m.organization_id = p_organization_id AND m.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'directory_provision_membership_exists' USING ERRCODE = '23505';
  END IF;
  INSERT INTO papercusp_auth.organization_memberships
    (organization_id, user_id, role, created_via, created_by_user_id)
  VALUES (p_organization_id, p_user_id, p_role, 'member_management', p_actor_user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$function$;
ALTER FUNCTION papercusp_auth.provision_directory_membership(uuid, uuid, text, uuid)
  OWNER TO hosted_owner;
REVOKE ALL ON FUNCTION papercusp_auth.provision_directory_membership(uuid, uuid, text, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION papercusp_auth.provision_directory_membership(uuid, uuid, text, uuid)
  TO hosted_service;
