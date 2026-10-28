-- 1606-datatype-registry-cleanup-kind.sql
--
-- Built-in work item kind 'cleanup' joins the datatype registry
-- (WI-6554700010042545; follows code-cleanup-campaigns-2026-10-26 P-003, D-003).
--
-- Migration 1590 made 'cleanup' an issue-family work item kind, so it is in
-- WORK_ITEM_KINDS. It was never added to the built-in kind rows that migration
-- 1318 seeds, or to the code constant BUILTIN_WORK_ITEM_KIND_NATURES. As a
-- result, datatypes:declare did not reserve the id 'cleanup' against a
-- user-declared datatype. This migration seeds the missing row in exactly the
-- shape 1318 uses. datatype-registry-store.test.ts pins the seed rows of 1318
-- and this migration to the constant and to WORK_ITEM_KINDS.
--
-- Additive and idempotent: one INSERT ... ON CONFLICT, no DDL.
INSERT INTO harness_shared.datatype_registry
  (id, workspace_id, pot_slug, title, description, tier, work_item_kind,
   payload_schema, authoritative_writer, self_improvement, status, published,
   review_status, tags, created_by, nature, audience, updated_at)
VALUES
  ('cleanup', 'papercusp-workspace', NULL, 'Cleanup',
   'Built-in work item kind: a code-cleanup campaign unit (issue family).',
   'first-class', 'cleanup', NULL, 'papercusp', NULL, 'active', FALSE, 'none',
   ARRAY['built-in','work-item-kind'], 'code-cleanup-campaigns-2026-10-26', 'work', 'agent', now())
ON CONFLICT (workspace_id, id) DO UPDATE SET
  nature = EXCLUDED.nature,
  audience = EXCLUDED.audience,
  updated_at = now();
