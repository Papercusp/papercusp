/**
 * Migration 904 — hosted users and external identity links.
 *
 * Executes the real migration against fresh PostgreSQL and pins the identity
 * boundary from BYOC plan P-075 / decision D-076: provider-subject uniqueness,
 * explicit lifecycle timestamps, no credential-bearing columns, and downgrade
 * safety for the legacy papercusp_auth relations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '904-hosted-identity-links.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 904 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'hostedidentity904' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });

  // Reproduce the downlevel schema migration 109 exposes. Migration 904 must
  // leave these tables and their data intact so rolling application code back
  // remains safe.
  await sql.unsafe(`
    CREATE SCHEMA papercusp_auth;
    CREATE TABLE papercusp_auth.users (
      id text PRIMARY KEY,
      email text NOT NULL UNIQUE,
      display_name text,
      github_login text UNIQUE,
      created_ts bigint NOT NULL,
      last_login_ts bigint
    );
    CREATE TABLE papercusp_auth.sessions (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES papercusp_auth.users(id) ON DELETE CASCADE,
      created_ts bigint NOT NULL,
      expires_ts bigint NOT NULL,
      user_agent text,
      ip text
    );
    CREATE TABLE papercusp_auth.magic_link_requests (
      token text PRIMARY KEY,
      email text NOT NULL,
      created_ts bigint NOT NULL,
      expires_ts bigint NOT NULL,
      consumed_ts bigint,
      ip text
    );
    INSERT INTO papercusp_auth.users
      (id, email, display_name, github_login, created_ts, last_login_ts)
    VALUES ('legacy-user', 'legacy@example.com', 'Legacy User', 'legacy', 1000, 2000);
  `);

  await sql.unsafe(migrationSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 904 — hosted identity links', () => {
  it('is idempotent and creates the two hosted-only relations', async () => {
    await sql.unsafe(migrationSql);

    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'papercusp_auth'
         AND table_name IN ('hosted_users', 'external_identities')
       ORDER BY table_name`;
    expect(rows.map((row) => row.table_name)).toEqual(['external_identities', 'hosted_users']);
  });

  it('carries explicit lifecycle timestamps and no credential-bearing columns', async () => {
    const rows = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type
        FROM information_schema.columns
       WHERE table_schema = 'papercusp_auth'
         AND table_name IN ('hosted_users', 'external_identities')
       ORDER BY table_name, ordinal_position`;

    const byTable = Map.groupBy(rows, (row) => row.table_name);
    expect(byTable.get('hosted_users')?.map((row) => row.column_name)).toEqual([
      'id',
      'primary_email',
      'display_name',
      'status',
      'created_at',
      'updated_at',
      'last_authenticated_at',
      'deactivated_at',
      'deleted_at',
    ]);
    expect(byTable.get('external_identities')?.map((row) => row.column_name)).toEqual([
      'id',
      'hosted_user_id',
      'provider',
      'subject',
      'provider_email',
      'profile',
      'status',
      'linked_at',
      'updated_at',
      'last_seen_at',
      'deactivated_at',
      'deleted_at',
    ]);

    const lifecycleColumns = rows.filter((row) => row.column_name.endsWith('_at'));
    expect(lifecycleColumns.length).toBeGreaterThanOrEqual(8);
    expect(lifecycleColumns.every((row) => row.data_type === 'timestamp with time zone')).toBe(true);

    const credentialColumns = rows.filter((row) =>
      /(password|hash|reset|mfa|totp|otp|secret|credential)/i.test(row.column_name),
    );
    expect(credentialColumns).toEqual([]);
  });

  it('maps one opaque provider/subject pair to exactly one internal hosted user', async () => {
    const [firstUser] = await sql<{ id: string }[]>`
      INSERT INTO papercusp_auth.hosted_users (primary_email, display_name)
      VALUES ('ada@example.com', 'Ada')
      RETURNING id`;
    const [secondUser] = await sql<{ id: string }[]>`
      INSERT INTO papercusp_auth.hosted_users (primary_email, display_name)
      VALUES ('grace@example.com', 'Grace')
      RETURNING id`;

    await sql`
      INSERT INTO papercusp_auth.external_identities
        (hosted_user_id, provider, subject, provider_email)
      VALUES (${firstUser.id}::uuid, 'workos', 'user_01HX', 'ada@example.com')`;

    await expect(sql`
      INSERT INTO papercusp_auth.external_identities
        (hosted_user_id, provider, subject)
      VALUES (${secondUser.id}::uuid, 'workos', 'user_01HX')`).rejects.toThrow(
      /external_identities_provider_subject_key/,
    );

    // Subjects are provider-owned opaque values: neither case-fold nor compare
    // them across providers.
    await sql`
      INSERT INTO papercusp_auth.external_identities
        (hosted_user_id, provider, subject)
      VALUES
        (${secondUser.id}::uuid, 'workos', 'USER_01HX'),
        (${secondUser.id}::uuid, 'github', 'user_01HX')`;
  });

  it('requires lifecycle state and timestamps to agree', async () => {
    await expect(sql`
      INSERT INTO papercusp_auth.hosted_users
        (primary_email, status, deactivated_at)
      VALUES ('invalid@example.com', 'active', now())`).rejects.toThrow(/hosted_users_lifecycle_ck/);

    const [user] = await sql<{ id: string }[]>`
      INSERT INTO papercusp_auth.hosted_users (primary_email)
      VALUES ('lifecycle@example.com')
      RETURNING id`;

    await sql`
      UPDATE papercusp_auth.hosted_users
         SET status = 'deactivated', deactivated_at = now(), updated_at = now()
       WHERE id = ${user.id}::uuid`;

    await expect(sql`
      INSERT INTO papercusp_auth.external_identities
        (hosted_user_id, provider, subject, status)
      VALUES (${user.id}::uuid, 'workos', 'deleted-without-timestamp', 'deleted')`).rejects.toThrow(
      /external_identities_lifecycle_ck/,
    );
  });

  it('does not mutate the legacy auth contract or its existing rows', async () => {
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'papercusp_auth'
         AND table_name = 'users'
       ORDER BY ordinal_position`;
    expect(columns.map((row) => row.column_name)).toEqual([
      'id',
      'email',
      'display_name',
      'github_login',
      'created_ts',
      'last_login_ts',
    ]);

    const rows = await sql<Array<{ id: string; email: string; last_login_ts: string }>>`
      SELECT id, email, last_login_ts::text
        FROM papercusp_auth.users
       WHERE id = 'legacy-user'`;
    expect(rows).toEqual([{ id: 'legacy-user', email: 'legacy@example.com', last_login_ts: '2000' }]);
  });
});
