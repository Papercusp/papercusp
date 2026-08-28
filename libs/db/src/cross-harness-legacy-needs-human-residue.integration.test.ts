/**
 * cross-harness-legacy-needs-human-residue.integration.test.ts — migration 1020.
 *
 * Migrations 864/867/868/870/950 each retired the payload.needsHuman dialect
 * under `harness_slug = 'papercusp'`, so three other harnesses were never in any
 * cohort. This proves 1020 repairs the residue WITHOUT a tenant predicate, and
 * — the assertion that carries the actual lesson — that the repair is observed
 * in more than one harness, so reintroducing a harness filter reds this file
 * instead of silently shipping a sixth single-harness wave.
 *
 * Run:
 *   npm run test:file -- libs/papercusp/libs/db/src/cross-harness-legacy-needs-human-residue.integration.test.ts
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
  HERE, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js',
);

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

function readMigration(name: string): string {
  const armed = path.join(SQL_DIR, name);
  if (existsSync(armed)) return readFileSync(armed, 'utf8');
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return readFileSync(draft, 'utf8');
  throw new Error(`migration ${name} not found at ${armed}[.DRAFT]`);
}

const MIGRATION_1020_SQL = readMigration(
  '1020-retire-cross-harness-legacy-needs-human-residue.sql',
);

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
        `migration provision incomplete: ${result.appliedCount}/${result.totalKnown}, failed=${result.failed.length}`,
      );
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;

async function applyMigration(): Promise<void> {
  try {
    await sql.unsafe(`BEGIN;\nSET LOCAL statement_timeout = 0;\n${MIGRATION_1020_SQL}\nCOMMIT;`);
  } catch (error) {
    await sql.unsafe('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** The live residue measured 2026-08-28, plus the two carve-outs and one claimed row. */
beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'xharnessneedshuman1020', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });

  await sql.unsafe(`
    DROP TABLE IF EXISTS harness_shared.bak_20260828_legacy_needs_human_cross_harness_1020;

    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
       created_ts, updated_ts, taken_by, payload)
    VALUES
      -- sidestage: 3 open + 3 needs-human (the live geometry)
      ('papercusp-workspace','sidestage','SS-OPEN-1','ChannelGuide presence writes','open','bug','local',10,10,NULL,'{"needsHuman":true}'::jsonb),
      ('papercusp-workspace','sidestage','SS-OPEN-2','claimable await woke a member','open','bug','local',11,11,NULL,'{"needsHuman":true}'::jsonb),
      ('papercusp-workspace','sidestage','SS-OPEN-3','copilot turn endpoint 201','open','bug','local',12,12,NULL,'{"needsHuman":true}'::jsonb),
      ('papercusp-workspace','sidestage','SS-NH-1','dev Postgres max_connections','needs-human','bug','local',13,13,NULL,'{"needsHuman":true}'::jsonb),
      ('papercusp-workspace','sidestage','SS-NH-2','prod transcription broken','needs-human','bug','local',14,14,NULL,'{"needsHuman":true}'::jsonb),
      ('papercusp-workspace','sidestage','SS-NH-3','transcript product-focus','needs-human','bug','local',15,15,NULL,'{"needsHuman":true}'::jsonb),
      -- oddsmith-hive: 2 needs-human
      ('papercusp-workspace','oddsmith-hive','OD-NH-1','git-sync committed the wipe','needs-human','bug','local',16,16,NULL,'{"needsHuman":true}'::jsonb),
      ('papercusp-workspace','oddsmith-hive','OD-NH-2','green-checkpoint stalled','needs-human','bug','local',17,17,NULL,'{"needsHuman":true}'::jsonb),
      -- papercusp-public-site-pot: 1 open
      ('papercusp-workspace','papercusp-public-site-pot','PS-OPEN-1','PostHog TLS handshake hangs','open','bug','local',18,18,NULL,'{"needsHuman":true}'::jsonb),
      -- CLAIM-NEUTRALITY probe: held by a peer, must still normalize without moving the claim
      ('papercusp-workspace','sidestage','SS-CLAIMED','held by a sidestage peer','open','bug','local',19,19,'su:sidestage-peer','{"needsHuman":true}'::jsonb),
      -- CARVE-OUT 1: observation lane is excluded by every wave, including this one
      ('papercusp-workspace','papercusp','PC-OBS-1','observation-lane note','open','change','local',20,20,NULL,'{"needsHuman":true,"lane":"observation"}'::jsonb),
      -- CARVE-OUT 2: terminal history is immutable
      ('papercusp-workspace','papercusp','PC-TERMINAL','terminal legacy history','done','bug','local',21,21,NULL,'{"needsHuman":true}'::jsonb);
  `);
}, 300_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1020 — retire the payper-harness needsHuman residue the papercusp-scoped waves missed', () => {
  it('clears the retired key everywhere, with no tenant predicate', async () => {
    await applyMigration();

    // The invariant, asserted with NO workspace_id/harness_slug filter. Scoping
    // this read to papercusp is what let five consecutive waves pass while three
    // harnesses stayed dirty, so the guard must never reintroduce that scope.
    const [{ residue }] = (await sql`
      SELECT count(*)::int AS residue
        FROM harness_shared.work_items
       WHERE status NOT IN ('done','passed','deprecated','resolved','closed','dropped')
         AND COALESCE(payload,'{}'::jsonb) ->> 'lane'  IS DISTINCT FROM 'observation'
         AND COALESCE(payload,'{}'::jsonb) ->> '_lane' IS DISTINCT FROM 'observation'
         AND COALESCE(payload,'{}'::jsonb) ->> 'needsHuman' = 'true'
    `) as Array<{ residue: number }>;
    expect(residue).toBe(0);
  });

  it('repairs MORE THAN ONE harness — a harness-scoped cohort cannot satisfy this', async () => {
    const rows = (await sql`
      SELECT harness_slug, count(*)::int AS count
        FROM harness_shared.work_items
       WHERE payload -> '_legacyNeedsHumanCrossHarness' ->> 'migration' = '1020'
       GROUP BY harness_slug ORDER BY harness_slug
    `) as Array<{ harness_slug: string; count: number }>;

    expect(Object.fromEntries(rows.map((r) => [r.harness_slug, r.count]))).toEqual({
      'oddsmith-hive': 2,
      'papercusp-public-site-pot': 1,
      sidestage: 7,
    });
    // The lesson, stated as an assertion: a single-harness repair is a regression.
    expect(rows.length).toBeGreaterThan(1);
  });

  it('preserves each human gate by swapping the legacy key for the typed one', async () => {
    const parked = (await sql`
      SELECT feature_id, status, payload
        FROM harness_shared.work_items
       WHERE feature_id IN ('SS-NH-1','OD-NH-1') ORDER BY feature_id
    `) as Array<{ feature_id: string; status: string; payload: Record<string, unknown> }>;
    for (const row of parked) {
      expect(row.status).toBe('needs-human');
      expect(row.payload).not.toHaveProperty('needsHuman');
      expect(row.payload.needsOwnerAction).toBe(true);
    }

    // An ordinary open row loses the stale flag and must NOT gain an owner gate.
    const [open] = (await sql`
      SELECT status, payload FROM harness_shared.work_items WHERE feature_id = 'SS-OPEN-1'
    `) as Array<{ status: string; payload: Record<string, unknown> }>;
    expect(open.status).toBe('open');
    expect(open.payload).not.toHaveProperty('needsHuman');
    expect(open.payload).not.toHaveProperty('needsOwnerAction');
  });

  it('is claim-neutral: it normalizes a held row without moving status or ownership', async () => {
    const [held] = (await sql`
      SELECT status, taken_by, payload FROM harness_shared.work_items WHERE feature_id = 'SS-CLAIMED'
    `) as Array<{ status: string; taken_by: string | null; payload: Record<string, unknown> }>;
    expect(held).toMatchObject({ status: 'open', taken_by: 'su:sidestage-peer' });
    expect(held.payload).not.toHaveProperty('needsHuman');
  });

  it('leaves the observation lane and terminal history untouched', async () => {
    const rows = (await sql`
      SELECT feature_id, status, payload
        FROM harness_shared.work_items
       WHERE feature_id IN ('PC-OBS-1','PC-TERMINAL') ORDER BY feature_id
    `) as Array<{ feature_id: string; status: string; payload: Record<string, unknown> }>;
    const byId = Object.fromEntries(rows.map((r) => [r.feature_id, r]));
    expect(byId['PC-OBS-1'].payload.needsHuman).toBe(true);
    expect(byId['PC-OBS-1'].payload).not.toHaveProperty('_legacyNeedsHumanCrossHarness');
    expect(byId['PC-TERMINAL'].payload.needsHuman).toBe(true);
    expect(byId['PC-TERMINAL'].payload).not.toHaveProperty('_legacyNeedsHumanCrossHarness');
  });

  it('backs up every mutated row and is idempotent', async () => {
    const [{ backups }] = (await sql`
      SELECT count(*)::int AS backups
        FROM harness_shared.bak_20260828_legacy_needs_human_cross_harness_1020
    `) as Array<{ backups: number }>;
    expect(backups).toBe(10);

    await applyMigration();

    const [{ backupsAfter, stamped }] = (await sql`
      SELECT
        (SELECT count(*)::int FROM harness_shared.bak_20260828_legacy_needs_human_cross_harness_1020)
          AS "backupsAfter",
        count(*) FILTER (
          WHERE payload -> '_legacyNeedsHumanCrossHarness' ->> 'migration' = '1020'
        )::int AS stamped
      FROM harness_shared.work_items
    `) as Array<{ backupsAfter: number; stamped: number }>;
    expect({ backupsAfter, stamped }).toEqual({ backupsAfter: 10, stamped: 10 });
  });
});
