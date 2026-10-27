-- 1595 — Partial GIN index on work_items payload->'paths' for the code-intel incident leg.
--
-- WHY. readPushIncidentAttribution (packages/operator-core/lib/code-intelligence/
-- push-channel.ts) finds open work-items whose payload.paths names a failing file.
-- With no index, its "open-on-path" half seq-scans every open work-item in the
-- harness and detoasts each payload. Measured 2026-10-27 on the dev box: 232,875
-- open papercusp items, 22,433 rows with a paths array table-wide, 474,897 shared
-- buffer hits, ~300 ms. The read runs under a 75 ms statement_timeout inside the
-- 250 ms push wall, so it failed every time ("canceling statement due to statement
-- timeout", :3170 07:50:51Z) and the incident leg never committed a push
-- (code-intel-delivery-and-outcomes-2026-10-26#P-002, WI-6554700010029476).
--
-- WHAT. The query now adds `jsonb_typeof(payload->'paths') = 'array'` (this
-- index's predicate, so the planner may use it) and `(payload->'paths') ?| paths`.
-- Measured on a copy of the table: Bitmap Index Scan, 0.12 ms, and the same rows as
-- the old predicate (2,071 = 2,071 for the five most-cited paths, all workspaces).
--
-- NOT CONCURRENTLY, deliberately: the runner applies each migration inside a
-- transaction, and CREATE INDEX CONCURRENTLY cannot run inside one (same tradeoff
-- as 794). A full read of the table's path predicate measured under 1 s, so the
-- write lock this build holds is short.
CREATE INDEX IF NOT EXISTS work_items_payload_paths_gin
  ON harness_shared.work_items USING gin ((payload->'paths'))
  WHERE jsonb_typeof(payload->'paths') = 'array';
