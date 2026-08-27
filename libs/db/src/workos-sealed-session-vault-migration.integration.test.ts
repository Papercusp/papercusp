import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '1002-workos-sealed-session-vault.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 1002 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

async function provisionMigrationRoles(): Promise<void> {
  await sql.unsafe(`
    DO $$
    DECLARE
      target_role text;
    BEGIN
      FOREACH target_role IN ARRAY ARRAY[
        'hosted_owner', 'hosted_app', 'hosted_service', 'harness_app', 'harness_zero'
      ]
      LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
          EXECUTE format(
            'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
            target_role
          );
        END IF;
      END LOOP;
      EXECUTE 'GRANT hosted_app TO harness_app WITH INHERIT FALSE';
      EXECUTE 'GRANT hosted_app TO harness_app WITH SET TRUE';
      EXECUTE format(
        'GRANT hosted_owner, hosted_app, hosted_service, harness_app, harness_zero TO %I',
        current_user
      );
    END
    $$;
  `);
}

async function asRole<T>(
  role: 'hosted_app' | 'hosted_service' | 'harness_app' | 'harness_zero',
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    return fn(tx);
  }) as Promise<T>;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'workosvault1002migration' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await provisionMigrationRoles();
  await sql.unsafe(migrationSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

beforeEach(async () => {
  await sql`TRUNCATE papercusp_auth.workos_sealed_sessions`;
});

describe('migration 1002 — WorkOS sealed-session vault', () => {
  it('is idempotent and pins ownership plus FORCE RLS to the hosted service boundary', async () => {
    await sql.unsafe(migrationSql);

    const [relation] = await sql<
      {
        owner: string;
        row_security: boolean;
        force_row_security: boolean;
      }[]
    >`
      SELECT owner_role.rolname AS owner,
             relation.relrowsecurity AS row_security,
             relation.relforcerowsecurity AS force_row_security
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
       WHERE namespace.nspname = 'papercusp_auth'
         AND relation.relname = 'workos_sealed_sessions'
    `;
    expect(relation).toEqual({
      owner: 'hosted_owner',
      row_security: true,
      force_row_security: true,
    });

    const [privileges] = await sql<
      {
        service_select: boolean;
        service_insert: boolean;
        service_update: boolean;
        service_delete: boolean;
        app_select: boolean;
      }[]
    >`
      SELECT
        has_table_privilege('hosted_service', 'papercusp_auth.workos_sealed_sessions', 'SELECT') AS service_select,
        has_table_privilege('hosted_service', 'papercusp_auth.workos_sealed_sessions', 'INSERT') AS service_insert,
        has_table_privilege('hosted_service', 'papercusp_auth.workos_sealed_sessions', 'UPDATE') AS service_update,
        has_table_privilege('hosted_service', 'papercusp_auth.workos_sealed_sessions', 'DELETE') AS service_delete,
        has_table_privilege('hosted_app', 'papercusp_auth.workos_sealed_sessions', 'SELECT') AS app_select
    `;
    expect(privileges).toEqual({
      service_select: true,
      service_insert: true,
      service_update: true,
      service_delete: true,
      app_select: false,
    });

    // EI-21638847910599943: the shared test cluster's harness_zero may already
    // be SUPERUSER because legacy fixtures create that cluster-global role with
    // elevated attributes. A behavioral denial assertion would therefore test
    // the contaminated fixture, not this migration. Inspect the table ACL
    // directly so default-privilege leakage to either local role is still caught.
    const directLocalGrants = await sql<{ grantee: string; privilege_type: string }[]>`
      SELECT grantee, privilege_type
        FROM information_schema.table_privileges
       WHERE table_schema = 'papercusp_auth'
         AND table_name = 'workos_sealed_sessions'
         AND grantee IN ('PUBLIC', 'harness_app', 'harness_zero')
       ORDER BY grantee, privilege_type
    `;
    expect(directLocalGrants).toEqual([]);
  });

  it('admits hosted_service CRUD', async () => {
    await asRole('hosted_service', async (tx) => {
      await tx`
        INSERT INTO papercusp_auth.workos_sealed_sessions
          (external_session_id, sealed_session, expires_at)
        VALUES ('session_service', 'sealed-service-payload', now() + interval '1 hour')
      `;
      const [row] = await tx<{ sealed_session: string }[]>`
        SELECT sealed_session
          FROM papercusp_auth.workos_sealed_sessions
         WHERE external_session_id = 'session_service'
      `;
      expect(row.sealed_session).toBe('sealed-service-payload');
      await tx`
        UPDATE papercusp_auth.workos_sealed_sessions
           SET sealed_session = 'sealed-service-payload-v2', updated_at = now()
         WHERE external_session_id = 'session_service'
      `;
    });

    await asRole('hosted_service', async (tx) => {
      await tx`
        DELETE FROM papercusp_auth.workos_sealed_sessions
         WHERE external_session_id = 'session_service'
      `;
    });
  });

  it.each(['hosted_app', 'harness_app'] as const)('%s cannot read provider ciphertext', async (role) => {
    await sql`
        INSERT INTO papercusp_auth.workos_sealed_sessions
          (external_session_id, sealed_session, expires_at)
        VALUES ('session_denied', 'sealed-denied-payload', now() + interval '1 hour')
      `;
    await expect(
      asRole(
        role,
        (tx) => tx`
            SELECT sealed_session FROM papercusp_auth.workos_sealed_sessions
          `,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('rejects blank identifiers, blank ciphertext, and non-forward expiries', async () => {
    await expect(sql`
      INSERT INTO papercusp_auth.workos_sealed_sessions
        (external_session_id, sealed_session, expires_at)
      VALUES ('', 'sealed', now() + interval '1 hour')
    `).rejects.toThrow(/external_id_nonempty/);

    await expect(sql`
      INSERT INTO papercusp_auth.workos_sealed_sessions
        (external_session_id, sealed_session, expires_at)
      VALUES ('session_blank', '   ', now() + interval '1 hour')
    `).rejects.toThrow(/payload_nonempty/);

    await expect(sql`
      INSERT INTO papercusp_auth.workos_sealed_sessions
        (external_session_id, sealed_session, expires_at)
      VALUES ('session_expired', 'sealed', now() - interval '1 second')
    `).rejects.toThrow(/expiry_after_create/);
  });

  it('indexes expiry for bounded retention cleanup', async () => {
    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = 'papercusp_auth'
         AND tablename = 'workos_sealed_sessions'
       ORDER BY indexname
    `;
    expect(indexes.map((row) => row.indexname)).toContain('workos_sealed_sessions_expiry_idx');
  });
});
