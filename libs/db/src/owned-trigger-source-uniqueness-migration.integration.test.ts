/** Migration 889 — one owned trigger source per user and provider kind. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '889-owned-trigger-source-uniqueness.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 889 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'owned889' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA harness_shared');
  await sql.unsafe(`
    CREATE TABLE harness_shared.trigger_sources (
      workspace_id text NOT NULL,
      kind text NOT NULL,
      owner_user_id uuid,
      credential_ref text
    )`);
  await sql.unsafe(migrationSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 889 — owned trigger-source uniqueness', () => {
  it('is idempotent and rejects a second owned source of the same kind', async () => {
    await sql.unsafe(migrationSql);
    const owner = '22222222-2222-4222-8222-222222222222';
    await sql`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, owner_user_id, credential_ref)
      VALUES ('ws-1', 'gcal', ${owner}::uuid, 'google-workspace:owner')`;
    await expect(sql`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, owner_user_id, credential_ref)
      VALUES ('ws-1', 'gcal', ${owner}::uuid, 'google-workspace:other')`
    ).rejects.toThrow(/trigger_sources_owned_user_kind_uidx/);

    await sql`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, owner_user_id, credential_ref)
      VALUES ('ws-1', 'gmail', ${owner}::uuid, 'google-workspace:owner')`;
  });

  it('leaves unowned legacy/source-definition rows outside the uniqueness fence', async () => {
    await sql`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, owner_user_id, credential_ref)
      VALUES
        ('ws-legacy', 'gcal', NULL, NULL),
        ('ws-legacy', 'gcal', NULL, NULL)`;
    const rows = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
        FROM harness_shared.trigger_sources
       WHERE workspace_id = 'ws-legacy'`;
    expect(rows).toEqual([{ count: 2 }]);
  });
});
