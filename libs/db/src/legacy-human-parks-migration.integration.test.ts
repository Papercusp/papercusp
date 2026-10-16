/**
 * legacy-human-parks-migration.integration.test.ts — migration 864
 * (abolish-human-review-agent-review-only-2026-08-02, P-006 / WI-40108).
 *
 * Exercises the real draft/armed SQL against a fully migrated Postgres. The
 * fixture mirrors the guarded execution census and includes the provenance,
 * collision, blocker-history, preserved-kind, and claim-floor edge cases that
 * make this migration unsafe to validate with string assertions alone.
 *
 * Run:
 *   npm run test:file -- libs/papercusp/libs/db/src/legacy-human-parks-migration.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(HERE, '..', 'sql');
const RUNNER = path.join(
  HERE,
  '..',
  '..',
  '..',
  'packages',
  'embedded-postgres-server',
  'src',
  'migration-runner.js',
);

function readMigration(name: string, override?: string): string {
  if (override) return readFileSync(override, 'utf8');
  const armed = path.join(SQL_DIR, name);
  if (existsSync(armed)) return readFileSync(armed, 'utf8');
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return readFileSync(draft, 'utf8');
  throw new Error(`migration ${name} not found at ${armed}[.DRAFT]`);
}

const MIGRATION_SQL = readMigration(
  '864-migrate-legacy-human-parks-to-agent-review.sql',
  process.env.LEGACY_HUMAN_PARKS_MIGRATION_SQL,
);
const MIGRATION_867_SQL = readMigration('867-repair-post-864-legacy-human-park-recurrence.sql');
const MIGRATION_870_SQL = readMigration('870-retire-post-868-legacy-human-park-recurrence.sql');
const MIGRATION_950_SQL = readMigration('950-retire-post-870-legacy-needs-human-recurrence-wave2.sql');
const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (options: {
        client: Sql;
        sqlDir: string;
      }) => Promise<{ appliedCount: number; totalKnown: number; failed: unknown[] }>;
    };
    const result = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    if (result.failed.length > 0 || result.appliedCount !== result.totalKnown) {
      throw new Error(
        `migration-864 provision incomplete: ${result.appliedCount}/${result.totalKnown}, failed=${result.failed.length}`,
      );
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;

async function applyMigration(migrationSql = MIGRATION_SQL, label = '864'): Promise<void> {
  try {
    await sql.unsafe(`BEGIN;\nSET LOCAL statement_timeout = 0;\n${migrationSql}\nCOMMIT;`);
  } catch (error) {
    await sql.unsafe('ROLLBACK').catch(() => {});
    throw new Error(`${label}: ${(error as Error).message}`, { cause: error });
  }
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'legacyparks864', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });

  await sql.unsafe(`
    -- The provision step applies the whole current migration chain. Later
    -- migrations may add work_items columns after 864 created its LIKE-based
    -- backup table; raw 864 replay would then compare current wi.* to that
    -- historical column shape. This isolated fixture models a database where
    -- 864 is still pending, so reset only the two artifacts 864 itself owns.
    DROP TABLE IF EXISTS harness_shared.bak_20260821_legacy_human_park_manifest;
    DROP TABLE IF EXISTS harness_shared.bak_20260821_legacy_human_parks;

    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
       created_ts, updated_ts, payload)
    SELECT 'papercusp-workspace', 'papercusp',
           'REMOTE-' || lpad(n::text, 3, '0'), 'Remote ' || n,
           CASE WHEN n = 1 THEN 'needs-human' ELSE 'open' END,
           'task', 'remote', 1, 1,
           CASE WHEN n = 1 THEN '{}'::jsonb ELSE '{"needsHuman":true}'::jsonb END
      FROM generate_series(1, 357) AS n;

    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
       created_ts, updated_ts, payload)
    SELECT 'papercusp-workspace', 'papercusp',
           'REVIEW-' || lpad(n::text, 3, '0'), 'Review ' || n, 'open',
           CASE n % 4 WHEN 0 THEN 'feature' WHEN 1 THEN 'bug'
                      WHEN 2 THEN 'change' ELSE 'task' END,
           'local', 1, 1,
           jsonb_build_object(
             'needsHuman', true,
             'ideaLifecycle', jsonb_build_object('triageDecision', 'gate'),
             '_ei', CASE WHEN n = 3 THEN jsonb_build_object('created_by', 'creator-3')
                         ELSE '{}'::jsonb END
           ) || CASE WHEN n = 5 THEN jsonb_build_object(
                  'externalBlockers', jsonb_build_array(jsonb_build_object(
                    'status', 'active', 'capability', 'product-decision',
                    'evidence', 'legacy review gate'
                  ))) ELSE '{}'::jsonb END
      FROM generate_series(1, 371) AS n;

    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
       created_ts, updated_ts, payload)
    SELECT 'papercusp-workspace', 'papercusp', owner_id, 'Owner ' || owner_id,
           'needs-human', 'task', 'local', 1, 1,
           jsonb_build_object(
             'needsHuman', true,
             'humanCapability', 'product-decision',
             'externalBlockers', jsonb_build_array(jsonb_build_object(
               'status', 'active', 'capability', 'product-decision',
               'evidence', 'legacy owner park'
             ))
           )
      FROM unnest(ARRAY[
        'EI-20192345878553998', 'EI-20360519880305472',
        'EI-20395113508971679', 'EI-20578449222009534',
        'WI-38516', 'WI-38664', 'WI-39114', 'WI-39622'
      ]) AS owner_id;

    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
       created_ts, updated_ts, payload)
    SELECT 'papercusp-workspace', 'papercusp',
           'OP-' || lpad(n::text, 3, '0'), 'Operational ' || n, 'open',
           'bug', 'local', 1, 1,
           jsonb_build_object('needsHuman', true)
           || CASE
                WHEN n = 1 THEN jsonb_build_object(
                  'externalBlockers', jsonb_build_array(jsonb_build_object(
                    'status', 'active', 'capability', 'live-dependency',
                    'evidence', 'dependency remains live'
                  )))
                WHEN n = 2 THEN jsonb_build_object(
                  'externalBlockers', jsonb_build_array(jsonb_build_object(
                    'status', 'active', 'capability', 'product-decision',
                    'evidence', 'legacy operational gate'
                  )))
                ELSE '{}'::jsonb
              END
      FROM generate_series(1, 23) AS n;

    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
       created_ts, updated_ts, payload)
    VALUES
      ('papercusp-workspace', 'papercusp', 'DRIFT-EXTRA', 'Drift sentinel',
       'open', 'bug', 'local', 1, 1, '{"needsHuman":true}'::jsonb);

    INSERT INTO harness_shared.scout_routed_ideas
      (idea_id, workspace_id, harness_slug, source_hive, lens, rail, routed_ref,
       title, routed_at, origin, created_by)
    VALUES
      ('REVIEW-001', 'papercusp-workspace', 'papercusp', 'papercusp',
       'legacy', 'improvement', 'wi:OTHER', 'Collision sentinel', 1,
       'agent-review', 'collision-author'),
      ('REVIEW-002', 'papercusp-workspace', 'papercusp', 'papercusp',
       'legacy', 'improvement', 'wi:REVIEW-002', 'Existing authority', 1,
       'agent-review', 'ledger-author-2');
  `);
}, 300_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 864 — guarded execution', () => {
  it('fails closed on census drift and live claims before applying the exact cohort', async () => {
    await expect(applyMigration()).rejects.toThrow(/expected 759=.*got 760=/);

    await sql`DELETE FROM harness_shared.work_items WHERE feature_id = 'DRIFT-EXTRA'`;
    await sql`UPDATE harness_shared.work_items SET taken_by = 'su:busy' WHERE feature_id = 'REVIEW-001'`;
    await expect(applyMigration()).rejects.toThrow(/refusing to migrate 1 claimed legacy row/);

    await sql`UPDATE harness_shared.work_items SET taken_by = NULL WHERE feature_id = 'REVIEW-001'`;
    await applyMigration();
  });

  it('lands the exact four-way census with no ambiguous legacy residue', async () => {
    const manifest = (await sql`
      SELECT destination, count(*)::int AS count
        FROM harness_shared.bak_20260821_legacy_human_park_manifest
       GROUP BY destination ORDER BY destination
    `) as Array<{ destination: string; count: number }>;
    expect(Object.fromEntries(manifest.map((row) => [row.destination, row.count]))).toEqual({
      'agent-review': 371,
      'operational': 23,
      'owner-action': 8,
      'remote-reconciliation': 357,
    });

    const [{ legacy, migrated }] = (await sql`
      SELECT
        count(*) FILTER (WHERE payload->>'needsHuman' = 'true')::int AS legacy,
        count(*) FILTER (WHERE payload->'_legacyHumanParkMigration'->>'migration' = '864')::int AS migrated
      FROM harness_shared.work_items
      WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
    `) as Array<{ legacy: number; migrated: number }>;
    expect({ legacy, migrated }).toEqual({ legacy: 0, migrated: 759 });
  });

  it('preserves kinds and applies deterministic review provenance/collision fallbacks', async () => {
    const [{ mismatches }] = (await sql`
      SELECT count(*) FILTER (WHERE wi.item_kind IS DISTINCT FROM b.item_kind)::int AS mismatches
        FROM harness_shared.bak_20260821_legacy_human_park_manifest b
        JOIN harness_shared.work_items wi USING (workspace_id, harness_slug, feature_id)
    `) as Array<{ mismatches: number }>;
    expect(mismatches).toBe(0);

    const rows = (await sql`
      SELECT feature_id,
             payload->'agentReview'->>'submittedBy' AS submitted_by,
             payload->'agentReview'->>'ledgerIdeaId' AS ledger_id
        FROM harness_shared.work_items
       WHERE feature_id IN ('REVIEW-001', 'REVIEW-002', 'REVIEW-003', 'REVIEW-004')
       ORDER BY feature_id
    `) as Array<{ feature_id: string; submitted_by: string; ledger_id: string }>;
    expect(rows).toEqual([
      { feature_id: 'REVIEW-001', submitted_by: 'system:legacy-agent-review', ledger_id: 'agent-review:REVIEW-001' },
      { feature_id: 'REVIEW-002', submitted_by: 'ledger-author-2', ledger_id: 'REVIEW-002' },
      { feature_id: 'REVIEW-003', submitted_by: 'creator-3', ledger_id: 'REVIEW-003' },
      { feature_id: 'REVIEW-004', submitted_by: 'system:legacy-agent-review', ledger_id: 'REVIEW-004' },
    ]);

    const ledger = (await sql`
      SELECT idea_id, routed_ref, created_by
        FROM harness_shared.scout_routed_ideas
       WHERE idea_id IN ('REVIEW-001', 'agent-review:REVIEW-001', 'REVIEW-002', 'REVIEW-003')
       -- Pin the byte ordering: private native PG uses locale C while Docker
       -- may use a language collation that sorts lowercase before uppercase.
       ORDER BY idea_id COLLATE "C"
    `) as Array<{ idea_id: string; routed_ref: string; created_by: string }>;
    expect(ledger).toEqual([
      { idea_id: 'REVIEW-001', routed_ref: 'wi:OTHER', created_by: 'collision-author' },
      { idea_id: 'REVIEW-002', routed_ref: 'wi:REVIEW-002', created_by: 'ledger-author-2' },
      { idea_id: 'REVIEW-003', routed_ref: 'wi:REVIEW-003', created_by: 'creator-3' },
      { idea_id: 'agent-review:REVIEW-001', routed_ref: 'wi:REVIEW-001', created_by: 'system:legacy-agent-review' },
    ]);
  });

  it('preserves live dependencies while clearing superseded product-decision blockers', async () => {
    const rows = (await sql`
      SELECT feature_id, status, payload
        FROM harness_shared.work_items
       WHERE feature_id IN ('OP-001', 'OP-002', 'REVIEW-005', 'WI-38516')
       ORDER BY feature_id
    `) as Array<{ feature_id: string; status: string; payload: Record<string, any> }>;
    const byId = Object.fromEntries(rows.map((row) => [row.feature_id, row]));

    expect(byId['OP-001'].status).toBe('blocked');
    expect(byId['OP-001'].payload.externalBlockers[0]).toMatchObject({
      status: 'active',
      capability: 'live-dependency',
    });
    expect(byId['OP-002'].status).toBe('open');
    expect(byId['OP-002'].payload.externalBlockers[0]).toMatchObject({
      status: 'cleared',
      capability: 'product-decision',
      clearedBy: 'system:migration-864',
    });
    expect(byId['REVIEW-005'].payload.externalBlockers[0]).toMatchObject({
      status: 'cleared',
      capability: 'product-decision',
    });
    expect(byId['WI-38516'].payload).toMatchObject({
      needsOwnerAction: true,
      humanCapability: 'external-service-action',
    });
    expect(byId['WI-38516'].payload.externalBlockers[0]).toMatchObject({
      status: 'active',
      capability: 'external-service-action',
      capabilitySource: 'explicit',
    });
  });

  it('retires only the legacy floor and keeps review/owner reservations authoritative', async () => {
    const [row] = (await sql`
      SELECT
        harness_shared.work_item_claim_floors(
          'papercusp-workspace', 'open', NULL, 'local', 'legacy', NULL, NULL,
          '{"needsHuman":true}'::jsonb, 'EI-LEGACY'
        ) AS legacy_floors,
        harness_shared.work_item_claim_floors(
          'papercusp-workspace', 'open', NULL, 'local', 'owner', NULL, NULL,
          '{"needsOwnerAction":true}'::jsonb, 'EI-OWNER'
        ) AS owner_floors,
        harness_shared.work_item_claim_floors(
          'papercusp-workspace', 'open', NULL, 'local', 'review', NULL, NULL,
          '{"agentReview":{"status":"pending"}}'::jsonb, 'EI-REVIEW'
        ) AS review_floors
    `) as Array<{ legacy_floors: string[]; owner_floors: string[]; review_floors: string[] }>;
    expect(row.legacy_floors).not.toContain('needs-human');
    expect(row.owner_floors).toContain('needs-owner-action');
    expect(row.review_floors).toContain('agent-review');

    const claimable = (await sql`
      SELECT feature_id FROM harness_shared.work_items_claimable
       WHERE feature_id IN ('OP-001', 'OP-002', 'REVIEW-001', 'WI-38516', 'REMOTE-001')
       ORDER BY feature_id
    `) as Array<{ feature_id: string }>;
    expect(claimable.map((entry) => entry.feature_id)).toEqual(['OP-002']);
  });

  it('is idempotent without duplicating backups or review authorities', async () => {
    const before = (await sql`
      SELECT
        (SELECT count(*)::int FROM harness_shared.bak_20260821_legacy_human_parks) AS backups,
        (SELECT count(*)::int FROM harness_shared.bak_20260821_legacy_human_park_manifest) AS manifest,
        (SELECT count(*)::int FROM harness_shared.scout_routed_ideas WHERE origin = 'agent-review') AS authorities
    `)[0] as { backups: number; manifest: number; authorities: number };

    await applyMigration();

    const after = (await sql`
      SELECT
        (SELECT count(*)::int FROM harness_shared.bak_20260821_legacy_human_parks) AS backups,
        (SELECT count(*)::int FROM harness_shared.bak_20260821_legacy_human_park_manifest) AS manifest,
        (SELECT count(*)::int FROM harness_shared.scout_routed_ideas WHERE origin = 'agent-review') AS authorities
    `)[0] as typeof before;
    expect(after).toEqual(before);
  });

  it('creates the empty manifest on a populated database with no classifiable legacy rows', async () => {
    // Reconstruct 864's pre-first-execution function/table state inside a
    // transaction. The provisioned DB is populated, but its legacy cohort was
    // already migrated; 864 must still install an empty manifest for 867/870/950.
    await sql.unsafe('BEGIN; SET LOCAL statement_timeout = 0;');
    try {
      await sql.unsafe(
        "INSERT INTO harness_shared.harness_registry (workspace_id, payload, updated_at) " +
          "VALUES ('papercusp-workspace', '{\"projects\":[{\"slug\":\"papercusp\",\"remote_hive\":false}]}'::jsonb, 1) " +
          'ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at',
      );
      await sql.unsafe(
        "INSERT INTO harness_shared.work_items " +
          '(workspace_id, harness_slug, feature_id, title, status, item_kind, origin, created_ts, updated_ts, payload) ' +
          "VALUES ('papercusp-workspace', 'papercusp', 'ZERO-COHORT-POPULATED', 'Ordinary populated row', 'open', 'bug', 'local', 1, 1, '{}'::jsonb) " +
          'ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING',
      );
      await sql.unsafe(
        'DROP TABLE IF EXISTS harness_shared.bak_20260821_legacy_human_park_manifest;\n' +
          'DROP TABLE IF EXISTS harness_shared.bak_20260821_legacy_human_parks;\n' +
          'DROP VIEW IF EXISTS harness_shared.work_items_claimable;\n' +
          'DROP FUNCTION harness_shared.work_item_claim_floors(text, text, text, text, text, text, text, jsonb, text);\n' +
          'ALTER FUNCTION harness_shared.work_item_claim_floors_v16(text, text, text, text, text, text, text, jsonb, text) RENAME TO work_item_claim_floors;',
      );

      await sql.unsafe(MIGRATION_SQL);

      const [selected] = await sql.unsafe(
        'SELECT count(*)::int AS rows FROM migration_864_manifest',
      );
      const [manifest] = await sql.unsafe(
        "SELECT to_regclass('harness_shared.bak_20260821_legacy_human_park_manifest') IS NOT NULL AS exists, " +
          '(SELECT count(*)::int FROM harness_shared.bak_20260821_legacy_human_park_manifest) AS rows, ' +
          "to_regprocedure('harness_shared.work_item_claim_floors_v16(text,text,text,text,text,text,text,jsonb,text)') IS NOT NULL AS has_v16, " +
          "to_regprocedure('harness_shared.work_item_claim_floors(text,text,text,text,text,text,text,jsonb,text)') IS NOT NULL AS has_public",
      );
      expect(selected.rows).toBe(0);
      expect(manifest).toMatchObject({
        exists: true,
        rows: 0,
        has_v16: true,
        has_public: true,
      });
    } finally {
      await sql.unsafe('ROLLBACK').catch(() => {});
    }
  });

  it('keeps owner census guards strict but admits a variable remote_hive peer through the repair chain', async () => {
    await sql.unsafe(`
      INSERT INTO harness_shared.harness_registry (workspace_id, payload, updated_at)
      VALUES (
        'papercusp-workspace',
        '{"projects":[{"slug":"papercusp","harness_kind":"hive","remote_hive":true,"self_repo":true}]}'::jsonb,
        1
      )
      ON CONFLICT (workspace_id) DO UPDATE
        SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at;

      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
         created_ts, updated_ts, payload)
      VALUES
        ('papercusp-workspace', 'papercusp', 'PEER-REMOTE-001',
         'Remote peer legacy row', 'needs-human', 'bug', 'remote', 1001, 1001,
         '{}'::jsonb),
        ('papercusp-workspace', 'papercusp', 'PEER-REVIEW-001',
         'Peer-local review row', 'open', 'bug', 'local', 1002, 1002,
         '{"needsHuman":true,"ideaLifecycle":{"triageDecision":"gate"}}'::jsonb);
    `);

    // Before this regression fix, 864 compared this legitimate two-row peer
    // cohort to the owner's 759-row historical census and aborted. The later
    // recurrence migrations repeated the same mistake even on a zero-row peer
    // cohort once an earlier backup witness existed.
    await applyMigration();
    await sql.unsafe(`
      -- Model an install where these sibling migrations are still pending.
      -- The provisioned test DB has historical backup tables created before
      -- later work_items columns; a real pending migration creates them from
      -- the current shape, so reset only the artifacts each replay owns.
      DROP TABLE IF EXISTS harness_shared.bak_20260821_legacy_human_recurrence_867;
      DROP TABLE IF EXISTS harness_shared.bak_20260821_legacy_human_recurrence_870;
      DROP TABLE IF EXISTS harness_shared.bak_20260825_legacy_needs_human_recurrence_950;
    `);
    await applyMigration(MIGRATION_867_SQL, '867');
    await applyMigration(MIGRATION_870_SQL, '870');

    // Make 950's owner-census branch structurally reachable without creating a
    // new active legacy row. A remote install must still skip only the count;
    // all of 950's row-level guards and postconditions execute normally.
    await sql.unsafe(`
      INSERT INTO harness_shared.bak_20260821_legacy_human_recurrence_870
      SELECT wi.* FROM harness_shared.work_items wi
       WHERE wi.workspace_id = 'papercusp-workspace'
         AND wi.harness_slug = 'papercusp'
         AND wi.feature_id = 'PEER-REMOTE-001'
      ON CONFLICT (workspace_id, harness_slug, feature_id) DO NOTHING;
    `);
    await applyMigration(MIGRATION_950_SQL, '950');

    const rows = (await sql`
      SELECT feature_id, status, origin,
             payload->>'needsHuman' AS needs_human,
             payload->'_legacyHumanParkMigration'->>'destination' AS destination,
             payload->'agentReview'->>'status' AS review_status
        FROM harness_shared.work_items
       WHERE feature_id IN ('PEER-REMOTE-001', 'PEER-REVIEW-001')
       ORDER BY feature_id
    `) as Array<{
      feature_id: string;
      status: string;
      origin: string;
      needs_human: string | null;
      destination: string;
      review_status: string | null;
    }>;
    expect(rows).toEqual([
      {
        feature_id: 'PEER-REMOTE-001',
        status: 'open',
        origin: 'remote',
        needs_human: null,
        destination: 'remote-reconciliation',
        review_status: null,
      },
      {
        feature_id: 'PEER-REVIEW-001',
        status: 'open',
        origin: 'local',
        needs_human: null,
        destination: 'agent-review',
        review_status: 'pending',
      },
    ]);
  });
});
