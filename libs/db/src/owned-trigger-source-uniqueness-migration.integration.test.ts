/** Migrations 889/959/960 — owned trigger-source identity rollout. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(filename: string): string {
  const armed = path.join(HERE, '..', 'sql', filename);
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration not found at ${armed}[.DRAFT]`);
}

const migration889Sql = readFileSync(migrationPath('889-owned-trigger-source-uniqueness.sql'), 'utf8');
const migration959Sql = readFileSync(migrationPath('959-owned-trigger-source-account-identity.sql'), 'utf8');
const migration960Sql = readFileSync(migrationPath('960-restore-owned-trigger-legacy-arbiter.sql'), 'utf8');
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
  await sql.unsafe(migration889Sql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('owned trigger-source identity migration rollout', () => {
  it('is idempotent and rejects a second owned source of the same kind', async () => {
    await sql.unsafe(migration889Sql);
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

  it('restores the legacy arbiter beside the account arbiter for the deploy window', async () => {
    await sql.unsafe(migration959Sql);
    await sql.unsafe(migration960Sql);
    await sql.unsafe(migration960Sql);

    const indexes = await sql<Array<{ indexname: string }>>`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = 'harness_shared'
         AND tablename = 'trigger_sources'
         AND indexname IN (
           'trigger_sources_owned_account_kind_uidx',
           'trigger_sources_owned_user_kind_uidx'
         )
       ORDER BY indexname`;
    expect(indexes).toEqual([
      { indexname: 'trigger_sources_owned_account_kind_uidx' },
      { indexname: 'trigger_sources_owned_user_kind_uidx' },
    ]);

    const owner = '33333333-3333-4333-8333-333333333333';
    await sql`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, owner_user_id, provider_account_id, credential_ref)
      VALUES ('ws-deploy-window', 'gmail', ${owner}::uuid, 'first@example.com', 'google-workspace:first')`;

    await sql`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, owner_user_id, provider_account_id, credential_ref)
      VALUES ('ws-deploy-window', 'gmail', ${owner}::uuid, 'first@example.com', 'google-workspace:rotated')
      ON CONFLICT (workspace_id, kind, owner_user_id)
        WHERE owner_user_id IS NOT NULL
      DO UPDATE SET credential_ref = EXCLUDED.credential_ref`;

    const rows = await sql<Array<{ credential_ref: string }>>`
      SELECT credential_ref
        FROM harness_shared.trigger_sources
       WHERE workspace_id = 'ws-deploy-window'
         AND kind = 'gmail'
         AND owner_user_id = ${owner}::uuid`;
    expect(rows).toEqual([{ credential_ref: 'google-workspace:rotated' }]);

    await expect(sql`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, owner_user_id, provider_account_id, credential_ref)
      VALUES ('ws-deploy-window', 'gmail', ${owner}::uuid, 'second@example.com', 'google-workspace:second')`
    ).rejects.toThrow(/trigger_sources_owned_user_kind_uidx/);
  });
});
