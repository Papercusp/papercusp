/** Migration 957 — account-scoped owned trigger-source identity. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '957-owned-trigger-source-account-identity.sql');
  if (existsSync(armed)) return armed;
  const draft = armed + '.DRAFT';
  if (existsSync(draft)) return draft;
  throw new Error(`migration 957 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'owned957' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA harness_shared');
  await sql.unsafe(`
    CREATE TABLE harness_shared.trigger_sources (
      workspace_id text NOT NULL,
      id uuid DEFAULT gen_random_uuid() NOT NULL,
      kind text NOT NULL,
      owner_user_id uuid,
      credential_ref text,
      cursor jsonb DEFAULT '{}'::jsonb NOT NULL
    );
    CREATE UNIQUE INDEX trigger_sources_owned_user_kind_uidx
      ON harness_shared.trigger_sources (workspace_id, kind, owner_user_id)
      WHERE owner_user_id IS NOT NULL;
  `);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 957 — owned provider-account identity', () => {
  it('backfills the existing suite in place and is idempotent', async () => {
    const owner = '22222222-2222-4222-8222-222222222222';
    const inserted = await sql<Array<{ id: string; kind: string }>>`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, owner_user_id, credential_ref, cursor)
      VALUES
        ('ws-1', 'gmail', ${owner}::uuid, 'google-workspace:owner', '{"historyId":"keep-me"}'),
        ('ws-1', 'gcal', ${owner}::uuid, 'google-workspace:owner', '{"syncToken":"keep-me-too"}')
      RETURNING id::text, kind`;

    await sql.unsafe(migrationSql);
    await sql.unsafe(migrationSql);

    const migrated = await sql<Array<{ id: string; kind: string; providerAccountId: string; cursor: unknown }>>`
      SELECT id::text, kind, provider_account_id AS "providerAccountId", cursor
        FROM harness_shared.trigger_sources
       WHERE workspace_id = 'ws-1'
       ORDER BY kind`;
    expect(migrated).toEqual([
      {
        id: inserted.find((row) => row.kind === 'gcal')?.id,
        kind: 'gcal',
        providerAccountId: 'google-workspace:owner',
        cursor: { syncToken: 'keep-me-too' },
      },
      {
        id: inserted.find((row) => row.kind === 'gmail')?.id,
        kind: 'gmail',
        providerAccountId: 'google-workspace:owner',
        cursor: { historyId: 'keep-me' },
      },
    ]);
  });

  it('allows a second account while rejecting a duplicate kind within one account', async () => {
    const owner = '33333333-3333-4333-8333-333333333333';
    await sql`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, owner_user_id, provider_account_id, credential_ref)
      VALUES
        ('ws-2', 'gmail', ${owner}::uuid, 'acct-a', 'google-workspace:a'),
        ('ws-2', 'gmail', ${owner}::uuid, 'acct-b', 'google-workspace:b')`;
    await expect(sql`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, owner_user_id, provider_account_id, credential_ref)
      VALUES ('ws-2', 'gmail', ${owner}::uuid, 'acct-a', 'google-workspace:a2')`
    ).rejects.toThrow(/trigger_sources_owned_account_kind_uidx/);
  });
});
