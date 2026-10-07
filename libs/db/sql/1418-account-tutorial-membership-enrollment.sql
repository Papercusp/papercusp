-- New authoritative memberships share this admission seam, including invited
-- and preassigned accounts. No backfill or status-update trigger: returning
-- accounts and restored legacy access must not infer a new enrollment.
CREATE OR REPLACE FUNCTION papercusp_auth.enroll_new_membership_product_tutorial()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, papercusp_auth
AS $function$
DECLARE
  enrollment jsonb;
BEGIN
  enrollment := jsonb_build_object('3', jsonb_build_object(
    'scope', jsonb_build_object('tenantId', NEW.organization_id::text, 'userId', NEW.user_id::text),
    'version', 3, 'revision', 0, 'mutationId', NULL, 'disposition', 'active',
    'currentLessonId', 'welcome', 'reviewedLessonIds', '[]'::jsonb));
  INSERT INTO papercusp_auth.hosted_user_preferences (organization_id, user_id, profile)
    VALUES (NEW.organization_id, NEW.user_id, jsonb_build_object('productTutorial', enrollment))
    ON CONFLICT (organization_id, user_id) DO UPDATE
      SET profile = jsonb_set(hosted_user_preferences.profile, '{productTutorial}',
        COALESCE(hosted_user_preferences.profile->'productTutorial', '{}'::jsonb) || enrollment),
        updated_at = now()
      WHERE hosted_user_preferences.profile #> '{productTutorial,3}' IS NULL;
  RETURN NEW;
END
$function$;
ALTER FUNCTION papercusp_auth.enroll_new_membership_product_tutorial() OWNER TO hosted_owner;
REVOKE ALL ON FUNCTION papercusp_auth.enroll_new_membership_product_tutorial() FROM PUBLIC;

DROP TRIGGER IF EXISTS new_membership_product_tutorial ON papercusp_auth.organization_memberships;
CREATE TRIGGER new_membership_product_tutorial
  AFTER INSERT ON papercusp_auth.organization_memberships
  FOR EACH ROW WHEN (NEW.status = 'active')
  EXECUTE FUNCTION papercusp_auth.enroll_new_membership_product_tutorial();
