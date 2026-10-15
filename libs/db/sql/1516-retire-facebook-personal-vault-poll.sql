-- P-003: the installed facebook provider uses the shared connector-sync driver.
-- Keep historical routine evidence; stop the obsolete per-provider action.
UPDATE harness_shared.routines
   SET active = FALSE, updated_at = now()
 WHERE target_role = 'system:facebook-personal-vault-poll';
