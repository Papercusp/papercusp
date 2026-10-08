-- 1430 — work-on-everything worklist: "only plans I pick" (WI-10007603,
-- plan woe-progress-table-2026-10-08 P-002).
--
-- [owner 2026-10-08] chose the scope rule "only plans I pick": the goal's
-- saved worklist is the real scope, and every other active plan is shown as
-- "not in the worklist" until the owner adds it.
--
-- The bundled package (goal-packages/work-on-everything 1.3.0) now declares the
-- active-workspace-plans worklist collection with defaultSelected:false. This
-- brings already-installed goals onto the same declaration. Selection then
-- follows readTypedPropertyCollection: with no owner policy saved, the stored
-- worklist value seeds the picks (a derivation; nothing is written on the
-- owner's behalf); once the owner saves worklist_policy, that policy alone
-- decides.
--
-- Data-only and idempotent: touches only declarations that still read
-- defaultSelected:true. No DDL.
UPDATE harness_shared.goals
   SET property_schema = jsonb_set(property_schema, '{worklist,collection,defaultSelected}', 'false'::jsonb),
       updated_at = now()
 WHERE property_schema->'worklist'->'collection'->>'source' = 'active-workspace-plans'
   AND property_schema->'worklist'->'collection'->'defaultSelected' = 'true'::jsonb;
