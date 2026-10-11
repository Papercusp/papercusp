-- 1443-merge-same-workspace-work-item-twins.sql
--
-- scope-unique-identifiers-2026-07-26 P-011 / WI-10008280 (decisions D-002, D-004, D-007, D-008).
--
-- A work item's identity is (workspace_id, feature_id) (D-002), but the table's
-- key is still (harness_slug, feature_id), so one id can live under several
-- harnesses of one workspace ("twins"). Migrations 826/859 repaired a frozen
-- 2026-08-13 set; later twins came from writers fixed in P-009 / P-010 (D-004).
-- This migration clears EVERY remaining twin set on whichever node runs it, so
-- P-012 can add UNIQUE (workspace_id, feature_id) everywhere:
--
--   1. FIXTURE rows in a twin set are deleted: harnesses named xbench-*,
--      heval*, contract-test-* (bench / harness-eval / contract-test residue;
--      the writers were fixed in P-009).
--   2. Rows of one set that share a TITLE are one item recorded twice. They
--      merge into one survivor, ranked: the harness that owns the row's source
--      plan; then a concrete harness over `operator:*` and retired slugs
--      (canonical_harness_slug); then the most advanced lifecycle state; then
--      the most recent update. A terminal state and completion fields on a
--      merged source carry onto a non-terminal survivor.
--   3. Rows of one set with DIFFERENT titles are different items that collided
--      on one id. One keeps the id, ranked: remote origin first (the minting
--      node owns that id), then a concrete harness, then the earliest created.
--      Every other row is renamed to a DETERMINISTIC migration-owned id derived
--      from (workspace, harness, old id), so every node renames its copy the
--      same way. The old id stays on payload._physicalTwinRekey, the alias
--      shape migration 826 introduced. When the renamed copy already arrived
--      from a peer that ran this first, the old-id row is a stale copy and is
--      deleted instead ('stale-delete').
--
-- Measured on papercusp-workspace 2026-10-11: 100 sets / 401 rows = 281 fixture
-- rows (46 heval, 14 contract-test, 221 xbench), 56 same-title sets (papercup /
-- papercup-hive / operator:papercusp-workspace / sidestage beside papercusp) and
-- 4 divergent sets (F-FIX-001, WI-10000294, WI-10000680, WI-2143331).
--
-- Rekeyed ids: WI- ids land in [9007101443000000, 9007102443000000), above
-- every node-slot block of migration 1442 (max 9007099999999999) and below
-- 2^53, so no node can ever mint them. EI- ids get a 20-digit 1443-prefixed
-- tail; F- ids keep their kind prefix (F-FIX-1443nnnnnnnnn).
--
-- Evidence: every touched work_items row, spec-revision edge, dependency edge,
-- carry note and coord link is copied into a bak_20261011_*_1443 table first
-- (dependency edges must be lifted before the deletes: migration 988's
-- endpoint-delete guard refuses a delete while any edge names the row), and each row's
-- action is recorded in bak_20261011_work_item_twin_manifest_1443. Kopia
-- snapshot 78509 (a314919e2ae98662e9152e2e4b3e01db) was taken before arming.
--
-- Federation: a deleted row must NOT ship a delete to peers. The outbox
-- capture keys a feature-row delete by feature_id under canonical_harness_slug(),
-- and canonical_harness_slug('papercup') = 'papercusp', so deleting a retired
-- `papercup` twin would delete the papercusp SURVIVOR on every peer. Each node
-- runs this migration itself, so its deletions are local by design. The
-- capture function already skips any row whose origin is not 'local' (its
-- echo-loop guard), so the rows about to be deleted are first marked
-- origin='remote'. No trigger is disabled and no ACCESS EXCLUSIVE lock is
-- taken: sync invalidation (emit_change_notify_trg) stays live, and merged
-- survivors / renamed rows federate like any other update. A twin created
-- concurrently would fail the postcondition and roll the whole migration back.
--
-- FORWARD-COMPAT: new backup tables only; no column, constraint or function
-- change. The deployed release treats ids as opaque text and no code path
-- depends on a twin existing (D-004).

SET LOCAL lock_timeout = '30s';

CREATE TABLE IF NOT EXISTS harness_shared.bak_20261011_work_item_twins_1443
  (LIKE harness_shared.work_items INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS bak_20261011_work_item_twins_1443_uq
  ON harness_shared.bak_20261011_work_item_twins_1443 (workspace_id, harness_slug, feature_id);

CREATE TABLE IF NOT EXISTS harness_shared.bak_20261011_work_item_twin_manifest_1443 (
  workspace_id     text NOT NULL,
  harness_slug     text NOT NULL,
  feature_id       text NOT NULL,
  action           text NOT NULL
                   CHECK (action IN ('keep', 'merge-delete', 'rekey', 'fixture-delete', 'stale-delete')),
  survivor_harness text,
  new_id           text,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, feature_id)
);

CREATE TABLE IF NOT EXISTS harness_shared.bak_20261011_work_item_twin_edges_1443
  (LIKE harness_shared.work_item_spec_revision_edges INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS bak_20261011_work_item_twin_edges_1443_uq
  ON harness_shared.bak_20261011_work_item_twin_edges_1443
     (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision);

CREATE TABLE IF NOT EXISTS harness_shared.bak_20261011_work_item_twin_carry_notes_1443
  (LIKE harness_shared.carry_notes INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS bak_20261011_work_item_twin_carry_notes_1443_uq
  ON harness_shared.bak_20261011_work_item_twin_carry_notes_1443 (workspace_id, scope);

CREATE TABLE IF NOT EXISTS harness_shared.bak_20261011_work_item_twin_links_1443
  (LIKE harness_shared.coord_links INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS bak_20261011_work_item_twin_links_1443_uq
  ON harness_shared.bak_20261011_work_item_twin_links_1443 (id);

CREATE TABLE IF NOT EXISTS harness_shared.bak_20261011_work_item_twin_deps_1443
  (LIKE harness_shared.work_item_deps INCLUDING DEFAULTS);
CREATE UNIQUE INDEX IF NOT EXISTS bak_20261011_work_item_twin_deps_1443_uq
  ON harness_shared.bak_20261011_work_item_twin_deps_1443 (id);

CREATE TEMP TABLE twin_1443 ON COMMIT DROP AS
SELECT w.workspace_id,
       w.harness_slug,
       w.feature_id,
       coalesce(w.title, '') AS title,
       w.status,
       coalesce(w.origin, 'local') AS origin,
       coalesce(w.created_ts, 0) AS created_ts,
       coalesce(w.updated_ts, 0) AS updated_ts,
       (w.harness_slug LIKE 'xbench-%'
        OR w.harness_slug LIKE 'heval%'
        OR w.harness_slug LIKE 'contract-test-%') AS is_fixture,
       (harness_shared.canonical_harness_slug(w.harness_slug) = w.harness_slug
        AND w.harness_slug NOT LIKE 'operator:%') AS is_concrete,
       EXISTS (SELECT 1 FROM harness_shared.harness_plans p
                WHERE p.workspace_id = w.workspace_id
                  AND p.harness_slug = w.harness_slug
                  AND p.plan_slug = w.source_plan_slug) AS owns_plan,
       CASE WHEN w.status IN ('passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped') THEN 3
            WHEN w.status IN ('wip', 'blocked', 'needs-human') THEN 2
            ELSE 1 END AS lifecycle,
       NULL::text AS action,
       NULL::text AS survivor_harness,
       NULL::text AS keeper_harness,
       NULL::text AS new_id
  FROM harness_shared.work_items w
 WHERE (w.workspace_id, w.feature_id) IN (
         SELECT workspace_id, feature_id
           FROM harness_shared.work_items
          GROUP BY workspace_id, feature_id
         HAVING count(*) > 1);

-- 1. Fixture residue.
UPDATE twin_1443 SET action = 'fixture-delete' WHERE is_fixture;

-- 2. Same id + same title = one item recorded twice: merge into a survivor.
WITH ranked AS (
  SELECT workspace_id, harness_slug, feature_id,
         row_number() OVER w AS rn,
         first_value(harness_slug) OVER w AS survivor
    FROM twin_1443
   WHERE NOT is_fixture
  WINDOW w AS (PARTITION BY workspace_id, feature_id, title
               ORDER BY owns_plan DESC, is_concrete DESC, lifecycle DESC,
                        updated_ts DESC, harness_slug)
)
UPDATE twin_1443 t
   SET action = CASE WHEN r.rn = 1 THEN NULL ELSE 'merge-delete' END,
       survivor_harness = r.survivor
  FROM ranked r
 WHERE t.workspace_id = r.workspace_id
   AND t.harness_slug = r.harness_slug
   AND t.feature_id = r.feature_id;

-- 3. What is left per id has distinct titles: one row keeps the id, the rest
--    are renamed.
WITH ranked AS (
  SELECT workspace_id, harness_slug, feature_id,
         row_number() OVER w AS rn,
         first_value(harness_slug) OVER w AS keeper
    FROM twin_1443
   WHERE action IS NULL
  WINDOW w AS (PARTITION BY workspace_id, feature_id
               ORDER BY (origin <> 'local') DESC, is_concrete DESC, created_ts, harness_slug)
)
UPDATE twin_1443 t
   SET action = CASE WHEN r.rn = 1 THEN 'keep' ELSE 'rekey' END,
       keeper_harness = r.keeper
  FROM ranked r
 WHERE t.workspace_id = r.workspace_id
   AND t.harness_slug = r.harness_slug
   AND t.feature_id = r.feature_id;

-- Deterministic new ids. ((h % n) + n) % n instead of abs(): abs() overflows
-- on the minimum bigint that hashtextextended can return.
WITH hashed AS (
  SELECT workspace_id, harness_slug, feature_id,
         hashtextextended(workspace_id || '/' || harness_slug || '/' || feature_id, 1443) AS h
    FROM twin_1443
   WHERE action = 'rekey'
)
UPDATE twin_1443 t
   SET new_id = CASE
         WHEN t.feature_id ~ '^WI-[0-9]+$'
           THEN 'WI-' || (9007101443000000::bigint + ((x.h % 1000000000) + 1000000000) % 1000000000)::text
         WHEN t.feature_id ~ '^EI-[0-9]+$'
           THEN 'EI-1443' || lpad((((x.h % 10000000000000) + 10000000000000) % 10000000000000)::text, 13, '0')
         WHEN t.feature_id LIKE 'F-%-%'
           THEN regexp_replace(t.feature_id, '-[^-]*$', '') || '-1443'
                || lpad((((x.h % 1000000000) + 1000000000) % 1000000000)::text, 9, '0')
         ELSE t.feature_id || '-r1443-'
                || lpad((((x.h % 1000000000) + 1000000000) % 1000000000)::text, 9, '0')
       END
  FROM hashed x
 WHERE t.workspace_id = x.workspace_id
   AND t.harness_slug = x.harness_slug
   AND t.feature_id = x.feature_id;

-- The renamed copy already exists under the same harness: a peer ran this
-- first and federated it here. The old-id row is a stale copy.
UPDATE twin_1443 t
   SET action = 'stale-delete'
 WHERE t.action = 'rekey'
   AND EXISTS (SELECT 1 FROM harness_shared.work_items w
                WHERE w.workspace_id = t.workspace_id
                  AND w.harness_slug = t.harness_slug
                  AND w.feature_id = t.new_id);

DO $guard1443$
DECLARE bad text;
BEGIN
  SELECT string_agg(workspace_id || '/' || harness_slug || '/' || feature_id, ', ') INTO bad
    FROM twin_1443 WHERE action IS NULL OR (action = 'rekey' AND new_id IS NULL);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '1443: unclassified twin rows: %', bad;
  END IF;

  SELECT string_agg(t.workspace_id || '/' || t.new_id, ', ') INTO bad
    FROM twin_1443 t
   WHERE t.action = 'rekey'
     AND (EXISTS (SELECT 1 FROM harness_shared.work_items w
                   WHERE w.workspace_id = t.workspace_id AND w.feature_id = t.new_id)
          OR EXISTS (SELECT 1 FROM twin_1443 o
                      WHERE o.action = 'rekey' AND o.workspace_id = t.workspace_id
                        AND o.new_id = t.new_id AND o.harness_slug <> t.harness_slug));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '1443: rekey target id already taken by another harness: %', bad;
  END IF;
END
$guard1443$;

INSERT INTO harness_shared.bak_20261011_work_item_twin_manifest_1443
       (workspace_id, harness_slug, feature_id, action, survivor_harness, new_id)
SELECT workspace_id, harness_slug, feature_id, action,
       CASE action WHEN 'merge-delete' THEN survivor_harness
                   WHEN 'rekey' THEN keeper_harness
                   WHEN 'stale-delete' THEN keeper_harness END,
       new_id
  FROM twin_1443
ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;

INSERT INTO harness_shared.bak_20261011_work_item_twins_1443
SELECT w.*
  FROM harness_shared.work_items w
  JOIN twin_1443 t USING (workspace_id, harness_slug, feature_id)
ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;

-- Spec-revision edges reference (workspace_id, harness_slug, feature_id) with
-- ON DELETE RESTRICT / ON UPDATE NO ACTION, and also reference the spec
-- revision in the SAME harness, so an edge cannot follow a row into another
-- harness. Back them up and drop them; rekeyed rows get theirs back below
-- under the new id (same harness).
INSERT INTO harness_shared.bak_20261011_work_item_twin_edges_1443
SELECT e.*
  FROM harness_shared.work_item_spec_revision_edges e
  JOIN twin_1443 t
    ON e.workspace_id = t.workspace_id AND e.harness_slug = t.harness_slug
   AND e.work_item_id = t.feature_id
 WHERE t.action IN ('merge-delete', 'fixture-delete', 'stale-delete', 'rekey')
ON CONFLICT DO NOTHING;

DELETE FROM harness_shared.work_item_spec_revision_edges e
 USING twin_1443 t
 WHERE e.workspace_id = t.workspace_id AND e.harness_slug = t.harness_slug
   AND e.work_item_id = t.feature_id
   AND t.action IN ('merge-delete', 'fixture-delete', 'stale-delete', 'rekey');

-- Checkpoints (carry_notes 'workitem:<harness>:<id>').
INSERT INTO harness_shared.bak_20261011_work_item_twin_carry_notes_1443
SELECT c.*
  FROM harness_shared.carry_notes c
  JOIN twin_1443 t
    ON c.workspace_id = t.workspace_id
   AND c.scope = 'workitem:' || t.harness_slug || ':' || t.feature_id
 WHERE t.action IN ('merge-delete', 'fixture-delete', 'stale-delete', 'rekey')
ON CONFLICT (workspace_id, scope) DO NOTHING;

-- A merged source's checkpoint moves to the survivor when the survivor has
-- none (the most recent one wins); the rest are dropped below (backed up).
WITH movable AS (
  SELECT DISTINCT ON (t.workspace_id, t.feature_id, t.survivor_harness)
         c.workspace_id, c.scope AS old_scope,
         'workitem:' || t.survivor_harness || ':' || t.feature_id AS new_scope
    FROM twin_1443 t
    JOIN harness_shared.carry_notes c
      ON c.workspace_id = t.workspace_id
     AND c.scope = 'workitem:' || t.harness_slug || ':' || t.feature_id
   WHERE t.action = 'merge-delete'
     AND NOT EXISTS (
           SELECT 1 FROM harness_shared.carry_notes s
            WHERE s.workspace_id = t.workspace_id
              AND s.scope = 'workitem:' || t.survivor_harness || ':' || t.feature_id)
   ORDER BY t.workspace_id, t.feature_id, t.survivor_harness, c.updated_ts DESC NULLS LAST
)
UPDATE harness_shared.carry_notes c
   SET scope = m.new_scope
  FROM movable m
 WHERE c.workspace_id = m.workspace_id AND c.scope = m.old_scope;

UPDATE harness_shared.carry_notes c
   SET scope = 'workitem:' || t.harness_slug || ':' || t.new_id
  FROM twin_1443 t
 WHERE t.action = 'rekey'
   AND c.workspace_id = t.workspace_id
   AND c.scope = 'workitem:' || t.harness_slug || ':' || t.feature_id;

DELETE FROM harness_shared.carry_notes c
 USING twin_1443 t
 WHERE t.action IN ('merge-delete', 'fixture-delete', 'stale-delete')
   AND c.workspace_id = t.workspace_id
   AND c.scope = 'workitem:' || t.harness_slug || ':' || t.feature_id;

-- Coord links are bare-id. A link moves with a renamed row only when its other
-- end names that row's harness as a whole ':'/'/'-separated token
-- (e.g. 'green-stall:<harness>'); every other bare reference keeps naming the
-- row that kept the id.
INSERT INTO harness_shared.bak_20261011_work_item_twin_links_1443
SELECT l.*
  FROM harness_shared.coord_links l
  JOIN twin_1443 t
    ON l.workspace_id = t.workspace_id AND t.action = 'rekey'
   AND ((l.src_ref = t.feature_id
         AND ':' || replace(l.dst_ref, '/', ':') || ':' LIKE '%:' || t.harness_slug || ':%')
     OR (l.dst_ref = t.feature_id
         AND ':' || replace(l.src_ref, '/', ':') || ':' LIKE '%:' || t.harness_slug || ':%'))
ON CONFLICT (id) DO NOTHING;

UPDATE harness_shared.coord_links l
   SET src_ref = t.new_id
  FROM twin_1443 t
 WHERE l.workspace_id = t.workspace_id AND t.action = 'rekey'
   AND l.src_ref = t.feature_id
   AND ':' || replace(l.dst_ref, '/', ':') || ':' LIKE '%:' || t.harness_slug || ':%';

UPDATE harness_shared.coord_links l
   SET dst_ref = t.new_id
  FROM twin_1443 t
 WHERE l.workspace_id = t.workspace_id AND t.action = 'rekey'
   AND l.dst_ref = t.feature_id
   AND ':' || replace(l.src_ref, '/', ':') || ':' LIKE '%:' || t.harness_slug || ':%';

-- Harness-qualified claim ledgers follow a renamed row; a live claim on a
-- deleted row is dropped. claim_audit / feature_claims history of deleted rows
-- is left as written.
UPDATE harness_shared.work_item_claims x SET work_item_id = t.new_id
  FROM twin_1443 t
 WHERE t.action = 'rekey' AND x.workspace_id = t.workspace_id
   AND x.harness_slug = t.harness_slug AND x.work_item_id = t.feature_id;
UPDATE harness_shared.feature_claims x SET feature_id = t.new_id
  FROM twin_1443 t
 WHERE t.action = 'rekey' AND x.workspace_id = t.workspace_id
   AND x.harness_slug = t.harness_slug AND x.feature_id = t.feature_id;
UPDATE harness_shared.claim_audit x SET feature_id = t.new_id
  FROM twin_1443 t
 WHERE t.action = 'rekey' AND x.workspace_id = t.workspace_id
   AND x.harness_slug = t.harness_slug AND x.feature_id = t.feature_id;
DELETE FROM harness_shared.work_item_claims x
 USING twin_1443 t
 WHERE t.action IN ('merge-delete', 'fixture-delete', 'stale-delete') AND x.workspace_id = t.workspace_id
   AND x.harness_slug = t.harness_slug AND x.work_item_id = t.feature_id;

-- Dependency edges (work_item_deps). An edge names a feature as
-- '<harness>#<id>' and an issue by its bare id, and the endpoint-delete guard
-- of migration 988 refuses to delete a row while ANY edge, in any workspace,
-- names it. So every edge naming a row that is deleted or renamed is backed
-- up and removed here, and put back below once the rows have moved:
--   fixture-delete                 -> dropped;
--   merge-delete (feature)         -> '<survivor>#<survivor's final id>';
--   rekey / stale-delete (feature) -> '<harness>#<new id>';
--   issue endpoint                 -> unchanged (a bare id keeps naming the row
--                                     that kept the id); dropped when no row keeps it.
-- An edge in a workspace where that ref is not a twin is put back unchanged.
CREATE TEMP TABLE twin_ref_1443 ON COMMIT DROP AS
SELECT DISTINCT t.workspace_id, k.kind,
       CASE k.kind WHEN 'issue' THEN t.feature_id
                   ELSE t.harness_slug || '#' || t.feature_id END AS old_ref,
       CASE
         WHEN k.kind = 'issue' THEN
           CASE WHEN EXISTS (SELECT 1 FROM twin_1443 o
                              WHERE o.workspace_id = t.workspace_id
                                AND o.feature_id = t.feature_id AND o.action = 'keep')
                THEN t.feature_id END
         WHEN t.action = 'fixture-delete' THEN NULL
         WHEN t.action IN ('rekey', 'stale-delete') THEN t.harness_slug || '#' || t.new_id
         WHEN t.action = 'merge-delete' THEN s.harness_slug || '#'
              || CASE WHEN s.action IN ('rekey', 'stale-delete') THEN s.new_id ELSE s.feature_id END
       END AS new_ref
  FROM twin_1443 t
  JOIN harness_shared.work_items w USING (workspace_id, harness_slug, feature_id)
  CROSS JOIN LATERAL (SELECT CASE WHEN w.item_kind IN ('bug', 'change', 'task')
                                  THEN 'issue' ELSE 'feature' END AS kind) k
  LEFT JOIN twin_1443 s
    ON t.action = 'merge-delete' AND s.workspace_id = t.workspace_id
   AND s.harness_slug = t.survivor_harness AND s.feature_id = t.feature_id
 WHERE t.action <> 'keep';

CREATE TEMP TABLE twin_dep_1443 ON COMMIT DROP AS
SELECT d.*
  FROM harness_shared.work_item_deps d
 WHERE EXISTS (SELECT 1 FROM twin_ref_1443 r
                WHERE (d.blocked_kind = r.kind AND d.blocked_ref = r.old_ref)
                   OR (d.blocker_kind = r.kind AND d.blocker_ref = r.old_ref));

INSERT INTO harness_shared.bak_20261011_work_item_twin_deps_1443
SELECT * FROM twin_dep_1443
ON CONFLICT (id) DO NOTHING;

DELETE FROM harness_shared.work_item_deps d
 USING twin_dep_1443 x
 WHERE d.id = x.id;

-- Merge each same-title source into its survivor. The most advanced source
-- (then the most recent) supplies the state; completion fields are filled
-- only when the survivor ends terminal.
WITH best AS (
  SELECT DISTINCT ON (t.workspace_id, t.feature_id, t.survivor_harness)
         t.workspace_id, t.feature_id, t.survivor_harness,
         w.status, w.completion_ref, w.terminal_completion_ref, w.terminal_owner,
         w.authority, w.closed_ts, w.payload
    FROM twin_1443 t
    JOIN harness_shared.work_items w USING (workspace_id, harness_slug, feature_id)
   WHERE t.action = 'merge-delete'
   ORDER BY t.workspace_id, t.feature_id, t.survivor_harness, t.lifecycle DESC, t.updated_ts DESC
), sources AS (
  SELECT t.workspace_id, t.feature_id, t.survivor_harness,
         jsonb_agg(jsonb_build_object('harness', t.harness_slug, 'status', t.status,
                                      'origin', t.origin, 'updatedTs', t.updated_ts)
                   ORDER BY t.harness_slug) AS list,
         max(t.updated_ts) AS max_updated
    FROM twin_1443 t
   WHERE t.action = 'merge-delete'
   GROUP BY t.workspace_id, t.feature_id, t.survivor_harness
), plan AS (
  SELECT b.*, src.list, src.max_updated,
         (s.status IN ('passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped')) AS survivor_terminal,
         (b.status IN ('passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped')) AS source_terminal
    FROM best b
    JOIN sources src USING (workspace_id, feature_id, survivor_harness)
    JOIN harness_shared.work_items s
      ON s.workspace_id = b.workspace_id AND s.harness_slug = b.survivor_harness
     AND s.feature_id = b.feature_id
)
UPDATE harness_shared.work_items s
   SET status = CASE WHEN NOT p.survivor_terminal AND p.source_terminal THEN p.status ELSE s.status END,
       completion_ref = CASE WHEN p.survivor_terminal OR p.source_terminal
                             THEN coalesce(s.completion_ref, p.completion_ref) ELSE s.completion_ref END,
       terminal_completion_ref = CASE WHEN p.survivor_terminal OR p.source_terminal
                             THEN coalesce(s.terminal_completion_ref, p.terminal_completion_ref)
                             ELSE s.terminal_completion_ref END,
       terminal_owner = CASE WHEN p.survivor_terminal OR p.source_terminal
                             THEN coalesce(s.terminal_owner, p.terminal_owner) ELSE s.terminal_owner END,
       authority = CASE WHEN p.survivor_terminal OR p.source_terminal
                        THEN coalesce(s.authority, p.authority) ELSE s.authority END,
       closed_ts = CASE WHEN p.survivor_terminal OR p.source_terminal
                        THEN coalesce(s.closed_ts, p.closed_ts) ELSE s.closed_ts END,
       updated_ts = greatest(coalesce(s.updated_ts, 0), p.max_updated),
       payload = coalesce(s.payload, '{}'::jsonb)
         || CASE WHEN (p.survivor_terminal OR p.source_terminal)
                  AND (coalesce(s.payload, '{}'::jsonb) -> '_completionEvidence') IS NULL
                  AND (coalesce(p.payload, '{}'::jsonb) -> '_completionEvidence') IS NOT NULL
                 THEN jsonb_build_object('_completionEvidence', p.payload -> '_completionEvidence')
                 ELSE '{}'::jsonb END
         || jsonb_build_object('_twinMerge', jsonb_build_object(
              'migration', 1443,
              'backupTable', 'harness_shared.bak_20261011_work_item_twins_1443',
              'sources', p.list))
  FROM plan p
 WHERE s.workspace_id = p.workspace_id
   AND s.harness_slug = p.survivor_harness
   AND s.feature_id = p.feature_id;

-- Rename the colliding rows. _physicalTwinRekey is the alias record (826 shape).
UPDATE harness_shared.work_items w
   SET feature_id = t.new_id,
       payload = coalesce(w.payload, '{}'::jsonb) || jsonb_build_object(
         '_physicalTwinRekey',
         jsonb_build_object('migration', 1443, 'oldId', t.feature_id,
                            'sourceHarness', t.harness_slug, 'keptBy', t.keeper_harness,
                            'backupTable', 'harness_shared.bak_20261011_work_item_twins_1443')
         || CASE WHEN (w.payload -> '_physicalTwinRekey') IS NOT NULL
                 THEN jsonb_build_object('previous', w.payload -> '_physicalTwinRekey')
                 ELSE '{}'::jsonb END)
  FROM twin_1443 t
 WHERE t.action = 'rekey'
   AND w.workspace_id = t.workspace_id
   AND w.harness_slug = t.harness_slug
   AND w.feature_id = t.feature_id;

INSERT INTO harness_shared.work_item_spec_revision_edges
       (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision,
        spec_fingerprint, created_by, created_at)
SELECT b.workspace_id, b.harness_slug, t.new_id, b.plan_slug, b.spec_id, b.spec_revision,
       b.spec_fingerprint, b.created_by, b.created_at
  FROM harness_shared.bak_20261011_work_item_twin_edges_1443 b
  JOIN twin_1443 t
    ON b.workspace_id = t.workspace_id AND b.harness_slug = t.harness_slug
   AND b.work_item_id = t.feature_id
 WHERE t.action = 'rekey'
ON CONFLICT DO NOTHING;

-- Local-only deletion: the outbox capture skips rows whose origin is not
-- 'local', so mark the doomed rows first (see the Federation note above).
-- fed_ts MUST move too: stamp_local_federated_write re-stamps origin='local' on
-- a local write it judges content-changing (measured 2026-10-11: an origin-only
-- UPDATE on xbench fixture rows came back 'local' and their deletes federated);
-- a write that moves fed_ts is treated as an apply/repair and left as written.
-- (Edited after this node applied it, D-010: same end state, no federated deletes.)
UPDATE harness_shared.work_items w
   SET origin = 'remote',
       fed_ts = coalesce(w.fed_ts, 0) + 1
  FROM twin_1443 t
 WHERE t.action IN ('merge-delete', 'fixture-delete', 'stale-delete')
   AND w.workspace_id = t.workspace_id
   AND w.harness_slug = t.harness_slug
   AND w.feature_id = t.feature_id
   AND w.origin IS DISTINCT FROM 'remote';

DELETE FROM harness_shared.work_items w
 USING twin_1443 t
 WHERE t.action IN ('merge-delete', 'fixture-delete', 'stale-delete')
   AND w.workspace_id = t.workspace_id
   AND w.harness_slug = t.harness_slug
   AND w.feature_id = t.feature_id;

-- Put the dependency edges back, re-pointed (see the block above the merge).
INSERT INTO harness_shared.work_item_deps
       (id, workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref,
        dep_type, created_by, created_at, satisfaction)
SELECT x.id, x.workspace_id, x.blocked_kind, bm.ref, x.blocker_kind, km.ref,
       x.dep_type, x.created_by, x.created_at, x.satisfaction
  FROM twin_dep_1443 x
  CROSS JOIN LATERAL (
    SELECT CASE WHEN r.old_ref IS NULL THEN x.blocked_ref ELSE r.new_ref END AS ref
      FROM (SELECT 1) one
      LEFT JOIN twin_ref_1443 r
        ON r.workspace_id = x.workspace_id AND r.kind = x.blocked_kind AND r.old_ref = x.blocked_ref
     LIMIT 1) bm
  CROSS JOIN LATERAL (
    SELECT CASE WHEN r.old_ref IS NULL THEN x.blocker_ref ELSE r.new_ref END AS ref
      FROM (SELECT 1) one
      LEFT JOIN twin_ref_1443 r
        ON r.workspace_id = x.workspace_id AND r.kind = x.blocker_kind AND r.old_ref = x.blocker_ref
     LIMIT 1) km
 WHERE bm.ref IS NOT NULL
   AND km.ref IS NOT NULL
   AND NOT (x.blocked_kind = x.blocker_kind AND bm.ref = km.ref)
ON CONFLICT DO NOTHING;

DO $post1443$
DECLARE bad text;
BEGIN
  SELECT string_agg(workspace_id || '/' || feature_id, ', ') INTO bad
    FROM (SELECT workspace_id, feature_id
            FROM harness_shared.work_items
           GROUP BY workspace_id, feature_id
          HAVING count(*) > 1
           LIMIT 20) q;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '1443: same-workspace work-item twins remain: %', bad;
  END IF;

  SELECT string_agg(t.workspace_id || '/' || t.harness_slug || '/' || t.feature_id, ', ') INTO bad
    FROM twin_1443 t
   WHERE (t.action IN ('rekey', 'stale-delete') AND NOT EXISTS (
            SELECT 1 FROM harness_shared.work_items w
             WHERE w.workspace_id = t.workspace_id AND w.harness_slug = t.harness_slug
               AND w.feature_id = t.new_id))
      -- The survivor may itself have been renamed in step 3 (it collided with
      -- a different-title row), so look it up under its FINAL id.
      OR (t.action = 'merge-delete' AND NOT EXISTS (
            SELECT 1 FROM twin_1443 s
              JOIN harness_shared.work_items w
                ON w.workspace_id = s.workspace_id AND w.harness_slug = s.harness_slug
               AND w.feature_id = CASE WHEN s.action IN ('rekey', 'stale-delete')
                                       THEN s.new_id ELSE s.feature_id END
             WHERE s.workspace_id = t.workspace_id AND s.harness_slug = t.survivor_harness
               AND s.feature_id = t.feature_id))
      OR (t.action <> 'keep' AND NOT EXISTS (
            SELECT 1 FROM harness_shared.bak_20261011_work_item_twins_1443 b
             WHERE b.workspace_id = t.workspace_id AND b.harness_slug = t.harness_slug
               AND b.feature_id = t.feature_id));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '1443: postcondition failed (missing survivor, renamed row or backup) for %', bad;
  END IF;
END
$post1443$;
