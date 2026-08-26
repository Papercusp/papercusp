/**
 * Migration 978 — hosted customer FORCE RLS boundary.
 *
 * Applies the real 903/904/906 leaf migrations followed by 907 against fresh
 * Postgres. These direct-query tests prove that the database fails closed when
 * hosted context is absent, Stage-A-shaped, or foreign; exposes only the exact
 * tenant slice; binds the non-superuser table owner; and keeps provider lifecycle
 * reconciliation incapable of granting application access.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationSql(name: string): string {
  // EI-21540187496878597: an integration test must never make an inert .DRAFT
  // look shipped. Requiring the armed path is the regression guard.
  return readFileSync(path.join(HERE, '..', 'sql', name), 'utf8');
}

const migrations = [
  migrationSql('903-customer-organization-boundary.sql'),
  migrationSql('904-hosted-identity-links.sql'),
  migrationSql('906-customer-workspace-directory.sql'),
  migrationSql('978-hosted-customer-rls.sql'),
];

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONTROL_A = 'control-plane-a';
const CONTROL_B = 'control-plane-b';
const CUSTOMER_A = 'customer-workspace-a';
const CUSTOMER_B = 'customer-workspace-b';

type Scope = {
  userId?: string;
  organizationId?: string;
  workspaceId?: string;
};

type VisibleCounts = {
  hosted_users: number;
  external_identities: number;
  organizations: number;
  organization_invitation_refs: number;
  organization_memberships: number;
  customer_workspaces: number;
  workspace_grants: number;
};

let db: MigratedTestDb;
let sql: Sql;

async function asRole<T>(
  role: 'hosted_app' | 'hosted_service' | 'hosted_owner',
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    return fn(tx);
  }) as Promise<T>;
}

async function setScope(tx: TransactionSql, scope: Scope): Promise<void> {
  if (scope.userId !== undefined) {
    await tx`SELECT set_config('app.user_id', ${scope.userId}, true)`;
  }
  if (scope.organizationId !== undefined) {
    await tx`SELECT set_config('app.organization_id', ${scope.organizationId}, true)`;
  }
  if (scope.workspaceId !== undefined) {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
  }
}

async function visibleCounts(tx: TransactionSql): Promise<VisibleCounts> {
  const [row] = await tx<VisibleCounts[]>`
    SELECT
      (SELECT count(*)::int FROM papercusp_auth.hosted_users) AS hosted_users,
      (SELECT count(*)::int FROM papercusp_auth.external_identities) AS external_identities,
      (SELECT count(*)::int FROM papercusp_auth.organizations) AS organizations,
      (SELECT count(*)::int FROM papercusp_auth.organization_invitation_refs)
        AS organization_invitation_refs,
      (SELECT count(*)::int FROM papercusp_auth.organization_memberships)
        AS organization_memberships,
      (SELECT count(*)::int FROM harness_shared.customer_workspaces)
        AS customer_workspaces,
      (SELECT count(*)::int FROM harness_shared.workspace_grants) AS workspace_grants`;
  return row;
}

const ZERO_COUNTS: VisibleCounts = {
  hosted_users: 0,
  external_identities: 0,
  organizations: 0,
  organization_invitation_refs: 0,
  organization_memberships: 0,
  customer_workspaces: 0,
  workspace_grants: 0,
};

async function seedTwoTenants(): Promise<void> {
  await sql`
    INSERT INTO papercusp_auth.hosted_users (id, primary_email, display_name)
    VALUES
      (${USER_A}::uuid, 'a@example.com', 'User A'),
      (${USER_B}::uuid, 'b@example.com', 'User B')`;

  await sql`
    INSERT INTO papercusp_auth.external_identities
      (hosted_user_id, provider, subject, provider_email)
    VALUES
      (${USER_A}::uuid, 'workos', 'subject-a', 'a@example.com'),
      (${USER_B}::uuid, 'workos', 'subject-b', 'b@example.com')`;

  await sql`
    INSERT INTO papercusp_auth.organizations
      (id, external_organization_id, display_name)
    VALUES
      (${ORG_A}::uuid, 'external-org-a', 'Organization A'),
      (${ORG_B}::uuid, 'external-org-b', 'Organization B')`;

  await sql`
    INSERT INTO papercusp_auth.organization_invitation_refs
      (organization_id, external_invitation_id, invitee_email)
    VALUES
      (${ORG_A}::uuid, 'invitation-a', 'invite-a@example.com'),
      (${ORG_B}::uuid, 'invitation-b', 'invite-b@example.com')`;

  await sql`
    INSERT INTO papercusp_auth.organization_memberships
      (organization_id, user_id, role, created_via)
    VALUES
      (${ORG_A}::uuid, ${USER_A}::uuid, 'member', 'organization_bootstrap'),
      (${ORG_B}::uuid, ${USER_B}::uuid, 'owner', 'organization_bootstrap')`;

  await sql`
    INSERT INTO harness_shared.workspace_hosts (workspace_id, id)
    VALUES
      (${CONTROL_A}, 'host-a'),
      (${CONTROL_B}, 'host-b')`;

  await sql`
    INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name,
       state, created_by_principal_kind, created_by_principal_id)
    VALUES
      (${CONTROL_A}, ${CUSTOMER_A}, ${ORG_A}, 'host-a', 'Customer A',
       'active', 'user', ${USER_A}),
      (${CONTROL_B}, ${CUSTOMER_B}, ${ORG_B}, 'host-b', 'Customer B',
       'active', 'user', ${USER_B})`;

  await sql`
    INSERT INTO harness_shared.workspace_grants
      (workspace_id, id, organization_id, customer_workspace_id,
       grantee_kind, grantee_id, permission,
       granted_by_principal_kind, granted_by_principal_id)
    VALUES
      (${CONTROL_A}, 'grant-a', ${ORG_A}, ${CUSTOMER_A},
       'user', ${USER_A}, 'workspace.view', 'user', ${USER_A}),
      (${CONTROL_B}, 'grant-b', ${ORG_B}, ${CUSTOMER_B},
       'user', ${USER_B}, 'workspace.view', 'user', ${USER_B})`;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'hostedrls907' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });

  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.workspace_hosts (
      workspace_id text NOT NULL,
      id text NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
  `);

  for (const migration of migrations) await sql.unsafe(migration);
  await seedTwoTenants();
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 978 — hosted customer FORCE RLS', () => {
  it('is idempotent and leaves every hosted role non-login, non-superuser, and non-bypass', async () => {
    await sql.unsafe(migrations[3]);

    const roles = await sql<
      {
        rolname: string;
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }[]
    >`
      SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
        FROM pg_roles
       WHERE rolname IN ('hosted_owner', 'hosted_app', 'hosted_service')
       ORDER BY rolname`;

    expect(roles).toEqual([
      { rolname: 'hosted_app', rolcanlogin: false, rolsuper: false, rolbypassrls: false },
      { rolname: 'hosted_owner', rolcanlogin: false, rolsuper: false, rolbypassrls: false },
      { rolname: 'hosted_service', rolcanlogin: false, rolsuper: false, rolbypassrls: false },
    ]);
  });

  it('forces RLS on every protected table and gives none to a hosted runtime role', async () => {
    const tables = await sql<
      {
        schema_name: string;
        table_name: string;
        table_owner: string;
        row_security: boolean;
        force_row_security: boolean;
      }[]
    >`
      SELECT
        n.nspname AS schema_name,
        c.relname AS table_name,
        owner_role.rolname AS table_owner,
        c.relrowsecurity AS row_security,
        c.relforcerowsecurity AS force_row_security
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles owner_role ON owner_role.oid = c.relowner
      WHERE (n.nspname, c.relname) IN (
        ('papercusp_auth', 'hosted_users'),
        ('papercusp_auth', 'external_identities'),
        ('papercusp_auth', 'organizations'),
        ('papercusp_auth', 'organization_invitation_refs'),
        ('papercusp_auth', 'organization_memberships'),
        ('harness_shared', 'customer_workspaces'),
        ('harness_shared', 'workspace_grants')
      )
      ORDER BY n.nspname, c.relname`;

    expect(tables).toHaveLength(7);
    expect(tables.every((table) => table.table_owner === 'hosted_owner')).toBe(true);
    expect(tables.every((table) => table.row_security && table.force_row_security)).toBe(true);
  });

  it('returns zero rows when tenant GUCs are unset', async () => {
    await expect(asRole('hosted_app', visibleCounts)).resolves.toEqual(ZERO_COUNTS);
  });

  it('does not accept the Stage-A process-global workspace id as hosted tenant context', async () => {
    const counts = await asRole('hosted_app', async (tx) => {
      await setScope(tx, { workspaceId: CONTROL_A });
      return visibleCounts(tx);
    });
    expect(counts).toEqual(ZERO_COUNTS);
  });

  it('returns zero rows for foreign organization/workspace context', async () => {
    const counts = await asRole('hosted_app', async (tx) => {
      await setScope(tx, {
        userId: '33333333-3333-4333-8333-333333333333',
        organizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        workspaceId: 'customer-workspace-foreign',
      });
      return visibleCounts(tx);
    });
    expect(counts).toEqual(ZERO_COUNTS);
  });

  it('shows only the exact user, organization, and selected customer workspace slice', async () => {
    const counts = await asRole('hosted_app', async (tx) => {
      await setScope(tx, {
        userId: USER_A,
        organizationId: ORG_A,
        workspaceId: CUSTOMER_A,
      });
      return visibleCounts(tx);
    });

    expect(counts).toEqual({
      hosted_users: 1,
      external_identities: 1,
      organizations: 1,
      organization_invitation_refs: 1,
      organization_memberships: 1,
      customer_workspaces: 1,
      workspace_grants: 1,
    });

    const mismatchedWorkspace = await asRole('hosted_app', async (tx) => {
      await setScope(tx, {
        userId: USER_A,
        organizationId: ORG_A,
        workspaceId: CUSTOMER_B,
      });
      const [row] = await tx<{ customer_workspaces: number; workspace_grants: number }[]>`
        SELECT
          (SELECT count(*)::int FROM harness_shared.customer_workspaces)
            AS customer_workspaces,
          (SELECT count(*)::int FROM harness_shared.workspace_grants)
            AS workspace_grants`;
      return row;
    });
    expect(mismatchedWorkspace).toEqual({ customer_workspaces: 0, workspace_grants: 0 });
  });

  it('binds the non-superuser table owner instead of relying on owner bypass', async () => {
    await expect(asRole('hosted_owner', visibleCounts)).resolves.toEqual(ZERO_COUNTS);
  });

  it('lets hosted_service reconcile lifecycle without granting application access', async () => {
    const serviceUser = '44444444-4444-4444-8444-444444444444';
    await asRole('hosted_service', async (tx) => {
      await tx`
        INSERT INTO papercusp_auth.hosted_users (id, primary_email)
        VALUES (${serviceUser}::uuid, 'service-created@example.com')`;
      await tx`
        INSERT INTO papercusp_auth.external_identities
          (hosted_user_id, provider, subject)
        VALUES (${serviceUser}::uuid, 'workos', 'service-created-subject')`;
      await tx`
        INSERT INTO papercusp_auth.organizations
          (external_organization_id, display_name)
        VALUES ('service-created-org', 'Service-created organization')`;
    });

    await expect(
      asRole(
        'hosted_service',
        (tx) => tx`
      INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, created_via)
      VALUES (${ORG_A}::uuid, ${USER_B}::uuid, 'member', 'member_management')
    `,
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asRole(
        'hosted_service',
        (tx) => tx`
      SELECT * FROM harness_shared.customer_workspaces
    `,
      ),
    ).rejects.toThrow(/permission denied/i);

    await asRole('hosted_service', async (tx) => {
      await tx`
        UPDATE papercusp_auth.organization_memberships
           SET status = 'suspended', suspended_at = now(), updated_at = now()
         WHERE organization_id = ${ORG_A}::uuid
           AND user_id = ${USER_A}::uuid`;
    });

    await expect(
      asRole(
        'hosted_service',
        (tx) => tx`
      UPDATE papercusp_auth.organization_memberships
         SET role = 'owner', updated_at = now()
       WHERE organization_id = ${ORG_A}::uuid
         AND user_id = ${USER_A}::uuid
    `,
      ),
    ).rejects.toThrow(/only reduce membership lifecycle state/i);

    await expect(
      asRole(
        'hosted_service',
        (tx) => tx`
      UPDATE papercusp_auth.organization_memberships
         SET status = 'active', suspended_at = NULL, updated_at = now()
       WHERE organization_id = ${ORG_A}::uuid
         AND user_id = ${USER_A}::uuid
    `,
      ),
    ).rejects.toThrow(/may not restore or elevate membership access/i);
  });
});
