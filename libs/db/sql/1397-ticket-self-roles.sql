-- 1397-ticket-self-roles.sql — linear-asana-task-sync-2026-10-05 P-006 (WI-10006366), D-012
--
-- Registers one more OPTIONAL property on the canonical `ticket` datatype (1332, 1377):
--
--   selfRoles[]  the roles the CONNECTED ACCOUNT of the ticket's data source holds on the
--                ticket: `assignee` and/or `delegate`. The provider computes it, because
--                only the provider can compare a ticket's people with its own account:
--                Linear compares assignee/delegate with `viewer` (Papercusp's app user
--                under actor=app), Asana compares the assignee with GET /users/me.
--                Admission presets match on it ("delegated to Papercusp" is
--                {"selfRoles":{"contains":"delegate"}}), so no rule has to name a person.
--
-- This supersedes 1377's note that an Asana assignment to the Papercusp user maps onto
-- `delegates`: `delegates` stays Linear's agent delegation (display names), and "is it
-- Papercusp's" is answered by selfRoles for every provider.
--
-- The patch is merged into payload_schema->'properties' with `||` (never drops a property
-- another writer added). The literal between the SELF-ROLES-PATCH markers is also read by
-- packages/operator-core/lib/data-sources/ticket-vocabulary.test.ts.
--
-- FORWARD-COMPAT: data-only and additive. The ticket schema keeps additionalProperties
-- true and the property is optional, so the deployed release accepts every payload it
-- accepted before and simply never reads selfRoles.

UPDATE harness_shared.datatype_registry
SET payload_schema = jsonb_set(
      payload_schema,
      '{properties}',
      COALESCE(payload_schema->'properties', '{}'::jsonb) ||
      -- SELF-ROLES-PATCH-BEGIN
      '{"selfRoles":{"type":"array","items":{"type":"string","enum":["assignee","delegate"]},"uniqueItems":true}}'::jsonb
      -- SELF-ROLES-PATCH-END
    ),
    updated_at = now()
WHERE workspace_id = 'papercusp-workspace'
  AND id = 'ticket';
