/**
 * legacy-human-park-status-repair.integration.test.ts — migration 868.
 *
 * Regression coverage for the migration-867 operational rewrite that reopened
 * rows whose recorded priorStatus was needs-human. The test applies both SQL
 * legs to a live migrated Postgres so the guards, backup, claim floor, and
 * idempotency behavior are exercised together.
 *
 * Run:
 *   npm run test:file -- libs/papercusp/libs/db/src/legacy-human-park-status-repair.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(HERE, '..', 'sql');
const RUNNER = path.join(HERE, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');

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

const MIGRATION_867_SQL = readMigration('867-repair-post-864-legacy-human-park-recurrence.sql');
const MIGRATION_868_SQL = readMigration('868-preserve-legacy-human-park-status.sql');

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

async function applyMigration(migrationSql: string): Promise<void> {
  try {
    await sql.unsafe(`BEGIN;\nSET LOCAL statement_timeout = 0;\n${migrationSql}\nCOMMIT;`);
  } catch (error) {
    await sql.unsafe('ROLLBACK').catch(() => {});
    throw error;
  }
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'legacypark868', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });

  await sql.unsafe(`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin,
       created_ts, updated_ts, payload)
    VALUES
      ('papercusp-workspace', 'papercusp', 'REPAIR-OPEN',
       '867 reopened an owner-gated row', 'needs-human', 'bug', 'local', 1, 1,
       jsonb_build_object(
         'needsHuman', true,
         '_legacyHumanParkMigration', jsonb_build_object(
           'migration', 864, 'destination', 'operational', 'priorStatus', 'needs-human'
         )
       )),
      ('papercusp-workspace', 'papercusp', 'REPAIR-BLOCKED',
       '867 converted an owner-gated row to blocked', 'needs-human', 'bug', 'local', 1, 1,
       jsonb_build_object(
         'needsHuman', true,
         'externalBlockers', jsonb_build_array(jsonb_build_object(
           'status', 'active', 'capability', 'product-decision', 'evidence', 'owner decision'
         )),
         '_legacyHumanParkMigration', jsonb_build_object(
           'migration', 864, 'destination', 'operational', 'priorStatus', 'needs-human'
         )
       )),
      ('papercusp-workspace', 'papercusp', 'REPAIR-CLAIMED',
       '867 must preserve a live claim', 'needs-human', 'bug', 'local', 1, 1,
       jsonb_build_object(
         'needsHuman', true,
         '_legacyHumanParkMigration', jsonb_build_object(
           'migration', 864, 'destination', 'operational', 'priorStatus', 'needs-human'
         )
       )),
      ('papercusp-workspace', 'papercusp', 'REPAIR-DONE',
       '867 must not touch terminal history', 'done', 'bug', 'local', 1, 1,
       jsonb_build_object(
         'needsHuman', true,
         '_legacyHumanParkMigration', jsonb_build_object(
           'migration', 864, 'destination', 'operational', 'priorStatus', 'needs-human'
         )
       ));

    UPDATE harness_shared.work_items
       SET taken_by = 'su:claimed'
     WHERE feature_id = 'REPAIR-CLAIMED';
  `);
}, 300_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 868 — preserve legacy human-park status', () => {
  it('repairs 867 operational rewrites, preserves claims, and is idempotent', async () => {
    await applyMigration(MIGRATION_867_SQL);

    const after867 = (await sql`
      SELECT feature_id, status, taken_by
        FROM harness_shared.work_items
       WHERE feature_id IN ('REPAIR-OPEN', 'REPAIR-BLOCKED', 'REPAIR-CLAIMED', 'REPAIR-DONE')
       ORDER BY feature_id
    `) as Array<{ feature_id: string; status: string; taken_by: string | null }>;
    expect(after867).toEqual([
      { feature_id: 'REPAIR-BLOCKED', status: 'blocked', taken_by: null },
      { feature_id: 'REPAIR-CLAIMED', status: 'needs-human', taken_by: 'su:claimed' },
      { feature_id: 'REPAIR-DONE', status: 'done', taken_by: null },
      { feature_id: 'REPAIR-OPEN', status: 'open', taken_by: null },
    ]);

    await applyMigration(MIGRATION_868_SQL);

    const repaired = (await sql`
      SELECT feature_id,
             status,
             taken_by,
             payload ->> 'needsHuman' AS needs_human,
             payload -> '_legacyHumanParkStatusRepair' ->> 'migration' AS repair_migration
        FROM harness_shared.work_items
       WHERE feature_id IN ('REPAIR-OPEN', 'REPAIR-BLOCKED', 'REPAIR-CLAIMED', 'REPAIR-DONE')
       ORDER BY feature_id
    `) as Array<{
      feature_id: string;
      status: string;
      taken_by: string | null;
      needs_human: string | null;
      repair_migration: string | null;
    }>;
    expect(repaired).toEqual([
      {
        feature_id: 'REPAIR-BLOCKED',
        status: 'needs-human',
        taken_by: null,
        needs_human: 'true',
        repair_migration: '868',
      },
      {
        feature_id: 'REPAIR-CLAIMED',
        status: 'needs-human',
        taken_by: 'su:claimed',
        needs_human: null,
        repair_migration: null,
      },
      { feature_id: 'REPAIR-DONE', status: 'done', taken_by: null, needs_human: 'true', repair_migration: null },
      {
        feature_id: 'REPAIR-OPEN',
        status: 'needs-human',
        taken_by: null,
        needs_human: 'true',
        repair_migration: '868',
      },
    ]);

    const [{ backups }] = (await sql`
      SELECT count(*)::int AS backups
        FROM harness_shared.bak_20260821_legacy_human_park_status_repair_868
    `) as Array<{ backups: number }>;
    expect(backups).toBe(2);

    await applyMigration(MIGRATION_868_SQL);
    const [{ backupsAfterRetry }] = (await sql`
      SELECT count(*)::int AS "backupsAfterRetry"
        FROM harness_shared.bak_20260821_legacy_human_park_status_repair_868
    `) as Array<{ backupsAfterRetry: number }>;
    expect(backupsAfterRetry).toBe(2);
  });
});
