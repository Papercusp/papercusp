import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migration(name: string, allowDraft = false): string {
  const armed = path.join(HERE, '..', 'sql', name);
  if (existsSync(armed)) return readFileSync(armed, 'utf8');
  if (allowDraft && existsSync(`${armed}.DRAFT`)) return readFileSync(`${armed}.DRAFT`, 'utf8');
  throw new Error(`migration not found at ${armed}${allowDraft ? '[.DRAFT]' : ''}`);
}

const migration902 = migration('902-hosted-session-webhook-receipts.sql');
const migration1002 = migration('1002-workos-sealed-session-vault.sql');
const migration1005 = migration('1005-hosted-service-lifecycle-runtime.sql', true);
const HOSTED_SESSION_ID = `hs_${'A'.repeat(43)}`;

let db: MigratedTestDb;
let sql: Sql;

async function provisionRoles(): Promise<void> {
  await sql.unsafe(`
    DO $$
    DECLARE
      target_role text;
    BEGIN
      FOREACH target_role IN ARRAY ARRAY[
        'hosted_owner', 'hosted_app', 'hosted_service',
        'harness_admin', 'harness_app', 'harness_zero'
      ]
      LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target_role) THEN
          EXECUTE format(
            'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
            target_role
          );
        END IF;
      END LOOP;
      -- A private test PG normally connects as harness_admin. PostgreSQL
      -- rejects a role granting itself, so skip that one target while
      -- still granting every other fixture role to the current admin.
      FOREACH target_role IN ARRAY ARRAY[
        'hosted_owner', 'hosted_app', 'hosted_service',
        'harness_admin', 'harness_app', 'harness_zero'
      ]
      LOOP
        IF target_role <> current_user THEN
          EXECUTE format('GRANT %I TO %I', target_role, current_user);
        END IF;
      END LOOP;
    END
    $$;
  `);
}

async function asRole<T>(
  role: 'hosted_service' | 'hosted_app' | 'harness_app',
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    return fn(tx);
  }) as Promise<T>;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'hostedservice1005migration' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await provisionRoles();
  await sql.unsafe(migration902);
  await sql.unsafe(migration1002);
  await sql.unsafe(migration1005);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

beforeEach(async () => {
  // TRUNCATE is intentionally not part of the hosted_service DML surface.
  // The fresh-database owner performs fixture cleanup; the tests below prove
  // the runtime role's ordinary SELECT/INSERT/UPDATE/DELETE contract.
  await sql`TRUNCATE papercusp_auth.hosted_sessions`;
  await sql`TRUNCATE papercusp_auth.webhook_event_receipts`;
  await sql`TRUNCATE papercusp_auth.workos_lifecycle_entity_cursors`;
});

describe('migration 1005 — hosted service lifecycle runtime', () => {
  it('is idempotent and pins the three runtime relations behind FORCE RLS', async () => {
    await sql.unsafe(migration1005);

    const relations = await sql<
      {
        table_name: string;
        owner: string;
        row_security: boolean;
        force_row_security: boolean;
      }[]
    >`
      SELECT relation.relname AS table_name,
             owner_role.rolname AS owner,
             relation.relrowsecurity AS row_security,
             relation.relforcerowsecurity AS force_row_security
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
       WHERE namespace.nspname = 'papercusp_auth'
         AND relation.relname IN (
           'hosted_sessions',
           'webhook_event_receipts',
           'workos_lifecycle_entity_cursors'
         )
       ORDER BY relation.relname
    `;

    expect(relations).toEqual([
      { table_name: 'hosted_sessions', owner: 'hosted_owner', row_security: true, force_row_security: true },
      {
        table_name: 'webhook_event_receipts',
        owner: 'hosted_owner',
        row_security: true,
        force_row_security: true,
      },
      {
        table_name: 'workos_lifecycle_entity_cursors',
        owner: 'hosted_owner',
        row_security: true,
        force_row_security: true,
      },
    ]);
  });

  it('grants harness_app explicit SET-only service membership', async () => {
    const [membership] = await sql<{ inherit_option: boolean; set_option: boolean; admin_option: boolean }[]>`
      SELECT membership.inherit_option,
             membership.set_option,
             membership.admin_option
        FROM pg_auth_members membership
        JOIN pg_roles granted ON granted.oid = membership.roleid
        JOIN pg_roles member ON member.oid = membership.member
       WHERE granted.rolname = 'hosted_service'
         AND member.rolname = 'harness_app'
    `;

    expect(membership).toEqual({ inherit_option: false, set_option: true, admin_option: false });
  });

  it('admits hosted_service session, receipt, and cursor DML', async () => {
    await asRole('hosted_service', async (tx) => {
      await tx`
        INSERT INTO papercusp_auth.hosted_sessions
          (id, user_id, organization_id, permission_version,
           upstream_provider, upstream_session_id, expires_at)
        VALUES
          (${HOSTED_SESSION_ID},
           '11111111-1111-4111-8111-111111111111',
           'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
           1, 'workos', 'session_workos_1', now() + interval '1 hour')
      `;
      await tx`
        INSERT INTO papercusp_auth.webhook_event_receipts
          (provider, event_id, event_type, event_created_at, payload,
           payload_sha256, retention_until, lifecycle_entity_key,
           lifecycle_cursor, lifecycle_mutation, closure_targets)
        VALUES
          ('workos', 'event_1', 'session.revoked', now(), '{}'::jsonb,
           ${'a'.repeat(64)}, now() + interval '90 days', 'workos:session:session_workos_1',
           '{"occurredAt":"2026-08-27T12:00:00.000Z","version":"1","eventId":"event_1"}'::jsonb,
           '{"kind":"revoke-session"}'::jsonb,
           '{"upstreamSessionIds":["session_workos_1"]}'::jsonb)
      `;
      await tx`
        INSERT INTO papercusp_auth.workos_lifecycle_entity_cursors
          (entity_key, occurred_at, event_version, event_id)
        VALUES ('workos:session:session_workos_1', now(), '1', 'event_1')
      `;

      const [counts] = await tx<{ sessions: number; receipts: number; cursors: number }[]>`
        SELECT
          (SELECT count(*)::int FROM papercusp_auth.hosted_sessions) AS sessions,
          (SELECT count(*)::int FROM papercusp_auth.webhook_event_receipts) AS receipts,
          (SELECT count(*)::int FROM papercusp_auth.workos_lifecycle_entity_cursors) AS cursors
      `;
      expect(counts).toEqual({ sessions: 1, receipts: 1, cursors: 1 });
    });
  });

  it('leaves local and hosted_app roles with no direct lifecycle-table grants', async () => {
    const directGrants = await sql<{ grantee: string; table_name: string; privilege_type: string }[]>`
      SELECT grantee, table_name, privilege_type
        FROM information_schema.table_privileges
       WHERE table_schema = 'papercusp_auth'
         AND table_name IN (
           'hosted_sessions',
           'webhook_event_receipts',
           'workos_lifecycle_entity_cursors'
         )
         AND grantee IN ('PUBLIC', 'harness_admin', 'harness_app', 'harness_zero', 'hosted_app')
       ORDER BY grantee, table_name, privilege_type
    `;
    expect(directGrants).toEqual([]);

    await expect(asRole('hosted_app', (tx) => tx`SELECT id FROM papercusp_auth.hosted_sessions`)).rejects.toThrow(
      /permission denied/,
    );
  });
});
