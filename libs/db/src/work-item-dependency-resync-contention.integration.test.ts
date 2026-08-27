/**
 * Migration 994 regression coverage for EI-21593117262092968.
 *
 * Migration 992's readiness backfill was procedural and shared a transaction
 * with ALTER TABLE work_item_deps.  The resulting ACCESS EXCLUSIVE lock made
 * scheduler dependency reads queue behind the backfill.  Migration 994 is a
 * forward-only, set-based repair for databases where 992 is already applied.
 *
 * Real Postgres (testcontainer; Docker required).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, '..', 'sql');
const RUNNER = join(here, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');
const MIGRATION_BASE = join(SQL_DIR, '994-work-item-dependency-resync-contention-guard.sql');
const MIGRATION_PATH = existsSync(MIGRATION_BASE) ? MIGRATION_BASE : `${MIGRATION_BASE}.DRAFT`;
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8');

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
      applyPendingMigrations: (o: { client: Sql; sqlDir: string }) => Promise<{
        appliedCount: number;
        totalKnown: number;
      }>;
    };
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    if (appliedCount !== totalKnown) {
      throw new Error(`dependency-resync provision: applied ${appliedCount}/${totalKnown}`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;

async function seedItem(id: string, status = 'todo', itemKind = 'feature'): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, created_ts, updated_ts, payload)
    VALUES
      ('default', 'resync-test', ${id}, ${`item ${id}`}, ${status}, ${itemKind}, 0, 0, '{}'::jsonb)`;
}

async function applyResync(): Promise<void> {
  await sql.unsafe(MIGRATION_SQL);
}

async function sidecarRows(): Promise<{ workspace_id: string; harness_slug: string; feature_id: string }[]> {
  return sql`
    SELECT workspace_id, harness_slug, feature_id
      FROM harness_shared.work_item_blocked
     WHERE harness_slug = 'resync-test'
     ORDER BY workspace_id, harness_slug, feature_id`;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'dep-resync-994', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

beforeEach(async () => {
  await sql`
    DELETE FROM harness_shared.work_item_blocked WHERE harness_slug = 'resync-test';
    DELETE FROM harness_shared.work_item_deps
     WHERE blocked_ref LIKE 'resync-test#%' OR blocker_ref LIKE 'resync-test#%';
    DELETE FROM harness_shared.work_items WHERE harness_slug = 'resync-test';
  `.simple();
});

describe('migration 994 — set-based readiness resync', () => {
  it('converges missing/extra sidecar rows and is idempotent', async () => {
    await seedItem('blocked', 'todo');
    await seedItem('live-blocker', 'todo');
    await seedItem('ready', 'todo');
    await sql`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      VALUES ('default', 'feature', 'resync-test#blocked', 'feature', 'resync-test#live-blocker', 'blocks')`;

    // Corrupt both directions after the triggers have established the baseline:
    // remove a required row and add a row for a ready feature plus a ghost.
    await sql`
      DELETE FROM harness_shared.work_item_blocked
       WHERE workspace_id = 'default' AND harness_slug = 'resync-test' AND feature_id = 'blocked'`;
    await sql`
      INSERT INTO harness_shared.work_item_blocked (workspace_id, harness_slug, feature_id)
      VALUES ('default', 'resync-test', 'ready'), ('default', 'resync-test', 'ghost')`;

    await applyResync();
    expect(await sidecarRows()).toEqual([{ workspace_id: 'default', harness_slug: 'resync-test', feature_id: 'blocked' }]);

    await applyResync();
    expect(await sidecarRows()).toEqual([{ workspace_id: 'default', harness_slug: 'resync-test', feature_id: 'blocked' }]);
  });

  it('finishes while work_item_deps has a concurrent access-share lock', async () => {
    // This is the lock shape that made 992's ALTER TABLE + procedural backfill
    // block scheduler dependency reads. A DML-only resync must not request the
    // conflicting ACCESS EXCLUSIVE lock and therefore must finish while the
    // reader holds ACCESS SHARE.
    await seedItem('lock-probe', 'todo');

    const holder = postgres(db.url, { max: 1, onnotice: () => {} });
    const runner = postgres(db.url, { max: 1, onnotice: () => {} });
    try {
      await holder.unsafe('BEGIN');
      await holder.unsafe('LOCK TABLE harness_shared.work_item_deps IN ACCESS SHARE MODE');

      const resync = runner.unsafe(MIGRATION_SQL);
      const outcome = await Promise.race([
        resync.then(() => 'completed' as const),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 2_000)),
      ]);
      expect(outcome).toBe('completed');
      await resync;
    } finally {
      await holder.unsafe('ROLLBACK').catch(() => {});
      await holder.end({ timeout: 5 }).catch(() => {});
      await runner.end({ timeout: 5 }).catch(() => {});
    }
  });

  it('contains no DDL or procedural per-row resync loop', () => {
    expect(MIGRATION_SQL).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(MIGRATION_SQL).not.toMatch(/\bDO\s+\$resync\$/i);
    expect(MIGRATION_SQL).not.toMatch(/\bFOR\s+r\s+IN\b/i);
    expect(MIGRATION_SQL).toMatch(/INSERT\s+INTO\s+harness_shared\.work_item_blocked[\s\S]*SELECT/i);
    expect(MIGRATION_SQL).toMatch(/DELETE\s+FROM\s+harness_shared\.work_item_blocked[\s\S]*NOT\s+EXISTS/i);
  });
});
