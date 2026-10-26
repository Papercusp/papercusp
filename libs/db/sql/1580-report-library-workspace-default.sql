-- Owner directives #2316/#2319: reports are workspace-public by default.
-- Publicize every existing edition in the owner's workspace, preserving bodies,
-- author identity and lineage. The owner-turn cutoff keeps future explicit
-- private reports private if this migration is ever re-applied.
ALTER TABLE harness_shared.report_library
  ALTER COLUMN visibility SET DEFAULT 'workspace'::text;

UPDATE harness_shared.report_library
   SET visibility = 'workspace', updated_at = now()
 WHERE workspace_id = 'papercusp-workspace'
   AND visibility IN ('owner', 'pot')
   AND published_at <= '2026-10-26T04:13:05.972Z'::timestamptz;
