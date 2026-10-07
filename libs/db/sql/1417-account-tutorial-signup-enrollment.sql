-- Extend the reviewed signup bootstrap, not hosted_service's table privileges.
-- hosted_owner is non-login; FORCE RLS still applies inside SECURITY DEFINER.
DROP POLICY IF EXISTS hosted_preferences_signup_owner ON papercusp_auth.hosted_user_preferences;
CREATE POLICY hosted_preferences_signup_owner ON papercusp_auth.hosted_user_preferences
  FOR ALL TO hosted_owner
  USING (EXISTS (SELECT 1 FROM papercusp_auth.organization_memberships m
    WHERE m.organization_id = hosted_user_preferences.organization_id
      AND m.user_id = hosted_user_preferences.user_id AND m.status = 'active'))
  WITH CHECK (EXISTS (SELECT 1 FROM papercusp_auth.organization_memberships m
    WHERE m.organization_id = hosted_user_preferences.organization_id
      AND m.user_id = hosted_user_preferences.user_id AND m.status = 'active'));

CREATE OR REPLACE FUNCTION papercusp_auth.bootstrap_hosted_self_signup_membership(
  p_organization_id uuid, p_user_id uuid
)
RETURNS TABLE(id uuid, updated_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, papercusp_auth
AS $function$
DECLARE
  enrollment jsonb;
BEGIN
  IF p_organization_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'self-signup membership ids are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO papercusp_auth.organization_memberships
    (organization_id, user_id, role, created_via, created_by_user_id)
  VALUES (p_organization_id, p_user_id, 'owner', 'organization_bootstrap', p_user_id)
  ON CONFLICT (organization_id, user_id) DO NOTHING;
  IF EXISTS (SELECT 1 FROM papercusp_auth.organization_memberships m
    WHERE m.organization_id = p_organization_id AND m.user_id = p_user_id AND m.status = 'active') THEN
    enrollment := jsonb_build_object('3', jsonb_build_object(
      'scope', jsonb_build_object('tenantId', p_organization_id::text, 'userId', p_user_id::text),
      'version', 3, 'revision', 0, 'mutationId', NULL, 'disposition', 'active',
      'currentLessonId', 'welcome', 'reviewedLessonIds', '[]'::jsonb));
    INSERT INTO papercusp_auth.hosted_user_preferences (organization_id, user_id, profile)
      VALUES (p_organization_id, p_user_id, jsonb_build_object('productTutorial', enrollment))
      ON CONFLICT (organization_id, user_id) DO UPDATE
        SET profile = jsonb_set(hosted_user_preferences.profile, '{productTutorial}',
          COALESCE(hosted_user_preferences.profile->'productTutorial', '{}'::jsonb) || enrollment), updated_at = now()
        WHERE hosted_user_preferences.profile #> '{productTutorial,3}' IS NULL;
  END IF;
  RETURN QUERY SELECT m.id, m.updated_at FROM papercusp_auth.organization_memberships m
    WHERE m.organization_id = p_organization_id AND m.user_id = p_user_id AND m.status = 'active' LIMIT 1;
END
$function$;
ALTER FUNCTION papercusp_auth.bootstrap_hosted_self_signup_membership(uuid, uuid) OWNER TO hosted_owner;
REVOKE ALL ON FUNCTION papercusp_auth.bootstrap_hosted_self_signup_membership(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION papercusp_auth.bootstrap_hosted_self_signup_membership(uuid, uuid) TO hosted_service;
