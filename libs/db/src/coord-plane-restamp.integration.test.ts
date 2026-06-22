/**
 * coord-plane-restamp.integration.test.ts — migration 361 moves the lever-(a)
 * coordination tables (coord_event_log / coord_watermarks / coord_open_escalations)
 * from workspace_id='default' → 'papercusp-workspace' collision-safely + idempotently
 * (workspace-data-isolation-leaks-2026-06-17 P-002 / F-C1, D-006).
 *
 * Provisions an ISOLATED database with the FULL harness_shared schema via the real
 * production boot-path migration runner (so 361 itself is exercised through the
 * actual runner against the real coord triggers), then seeds 'default' rows and
 * re-applies 361 (idempotent) to assert the data move.
 *
 * Real Postgres (testcontainer; Docker required; pgvector image). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/coord-plane-restamp.integration.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, '..', 'sql');
const RUNNER = join(here, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');
const MIGRATION_SQL = readFileSync(join(SQL_DIR, '361-coord-plane-workspace-restamp.sql'), 'utf8');
const PW = 'papercusp-workspace';

// Roles + extensions the real migrations GRANT to / depend on (mirrors
// embedded-postgres-server boot + the baseline-schema globalSetup).
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

/** Build the full schema (incl. migration 361) into the fresh DB via the real runner. */
async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (o: { client: Sql; sqlDir: string }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    // 361 is part of the set — a clean full apply proves it runs under the real runner.
    if (appliedCount !== totalKnown) {
      throw new Error(`coord-restamp provision: applied ${appliedCount}/${totalKnown} (expected zero skips)`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'coordrestamp', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

/** Wipe the three tables and seed a deterministic fixture. coord_event_log's user
 *  triggers are OFF during the insert so the open-escalations projection trigger
 *  can't inject extra rows / PK-collide on the seed. */
async function reseed(): Promise<void> {
  await sql.unsafe(`DELETE FROM harness_shared.coord_event_log`);
  await sql.unsafe(`DELETE FROM harness_shared.coord_watermarks`);
  await sql.unsafe(`DELETE FROM harness_shared.coord_open_escalations`);

  await sql.unsafe(`ALTER TABLE harness_shared.coord_event_log DISABLE TRIGGER USER`);
  try {
    await sql.unsafe(`INSERT INTO harness_shared.coord_event_log (surface, msg_id, body, workspace_id) VALUES
      ('messages',    'd-m1', '{"from":"a"}'::jsonb, 'default'),
      ('handoffs',    'd-h1', '{"from":"a"}'::jsonb, 'default'),
      ('escalations', 'd-e1', '{"from":"a"}'::jsonb, 'default'),
      ('plan-events', 'd-p1', '{"from":"a"}'::jsonb, 'default'),
      ('messages',    'pw-m1','{"from":"b"}'::jsonb, '${PW}'),
      ('messages',    'gt-m1','{"from":"c"}'::jsonb, 'generic-test')`);
  } finally {
    await sql.unsafe(`ALTER TABLE harness_shared.coord_event_log ENABLE TRIGGER USER`);
  }

  // owner-collide has BOTH a current 'default' read-position (99) and a stale
  // papercusp one (5) — the migration must keep the default (current) one.
  await sql.unsafe(`INSERT INTO harness_shared.coord_watermarks (workspace_id, owner_id, surfaces) VALUES
    ('default',     'owner-default-only', '{"messages":10}'::jsonb),
    ('default',     'owner-collide',      '{"messages":99}'::jsonb),
    ('${PW}',       'owner-collide',      '{"messages":5}'::jsonb),
    ('${PW}',       'owner-pw-only',      '{"messages":7}'::jsonb),
    ('generic-test','owner-gt',           '{"messages":3}'::jsonb)`);

  await sql.unsafe(`INSERT INTO harness_shared.coord_open_escalations (workspace_id, msg_id, ts, body) VALUES
    ('default', 'd-esc1',  now(), '{"x":1}'::jsonb),
    ('${PW}',   'pw-esc1', now(), '{"x":2}'::jsonb)`);
}

async function applyMigration(): Promise<void> {
  await sql.unsafe(MIGRATION_SQL);
}

const count = async (table: string, ws: string): Promise<number> => {
  const r = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM harness_shared.${table} WHERE workspace_id = $1`,
    [ws],
  )) as { n: number }[];
  return r[0]!.n;
};

beforeEach(reseed);

describe('migration 361 — coord-plane default→papercusp re-stamp', () => {
  it('moves every default coord_event_log row to papercusp; leaves other workspaces untouched', async () => {
    await applyMigration();
    expect(await count('coord_event_log', 'default')).toBe(0);
    expect(await count('coord_event_log', PW)).toBe(5); // 4 moved + 1 pre-existing
    expect(await count('coord_event_log', 'generic-test')).toBe(1); // untouched
  });

  it('resolves the watermark collision — keeps the current default read-position, drops the stale papercusp dupe', async () => {
    await applyMigration();
    const wm = (await sql.unsafe(
      `SELECT workspace_id, surfaces FROM harness_shared.coord_watermarks WHERE owner_id = 'owner-collide'`,
    )) as { workspace_id: string; surfaces: { messages: number } }[];
    expect(wm).toHaveLength(1);
    expect(wm[0]!.workspace_id).toBe(PW);
    expect(wm[0]!.surfaces.messages).toBe(99); // the live 'default' read-position won, not the stale 5
    expect(await count('coord_watermarks', 'default')).toBe(0);
    const total = (await sql.unsafe(`SELECT count(*)::int AS n FROM harness_shared.coord_watermarks`)) as { n: number }[];
    expect(total[0]!.n).toBe(4); // default-only(moved) + collide(1) + pw-only + gt
    expect(await count('coord_watermarks', 'generic-test')).toBe(1); // untouched
  });

  it('moves open escalations off default', async () => {
    await applyMigration();
    expect(await count('coord_open_escalations', 'default')).toBe(0);
    expect(await count('coord_open_escalations', PW)).toBe(2); // 1 moved + 1 pre-existing
  });

  it('is idempotent — a second apply moves nothing and state stays consistent', async () => {
    await applyMigration();
    await applyMigration();
    expect(await count('coord_event_log', 'default')).toBe(0);
    expect(await count('coord_event_log', PW)).toBe(5);
    expect(await count('coord_watermarks', 'default')).toBe(0);
    expect(await count('coord_open_escalations', 'default')).toBe(0);
  });

  it('restores every coord_event_log trigger it disabled (none left disabled)', async () => {
    await applyMigration();
    const trg = (await sql.unsafe(
      `SELECT t.tgname, t.tgenabled FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'harness_shared' AND c.relname = 'coord_event_log'
          AND t.tgname = ANY(ARRAY['capture_coord_event_upd_trg','emit_change_notify_trg','stamp_local_federated_write_trg'])`,
    )) as { tgname: string; tgenabled: string }[];
    expect(trg.length).toBeGreaterThan(0); // the full schema carries these triggers
    for (const r of trg) expect(r.tgenabled).toBe('O'); // 'O' = enabled (origin)
  });
});
