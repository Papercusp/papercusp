/**
 * Real-Postgres proof for the hosted tenant transaction wrapper: all GUCs are
 * transaction-local, the transaction actually RUNS AS `hosted_app`, FORCE-RLS
 * policies keyed on those GUCs deny cross-tenant access, concurrent callers
 * cannot observe each other's scope, and callback failure rolls back both data
 * and context.
 *
 * **The fixture is hermetic on purpose.** This suite does not apply the real
 * migrations; it builds the smallest schema that reproduces the production
 * shape — `hosted_app` assumed via `SET LOCAL ROLE`, FORCE RLS on, policies
 * `TO hosted_app` keyed on `current_setting('app.organization_id')`, mirroring
 * migration 978. Postgres roles are CLUSTER-wide, so relying on `hosted_app`
 * merely happening to exist from some other suite's migration run would make
 * this file pass or fail on ambient state; it creates and grants what it needs.
 * The migrations' own policies are covered by
 * `hosted-customer-rls-migration.integration.test.ts` — what is proven HERE is
 * that `withTenantContext` supplies the role and the GUCs those policies need.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: null as unknown as Sql }));
vi.mock('./connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./connection')>()),
  getOrgPgApp: () => ({ sql: h.sql }),
  getOrgPg: () => ({ sql: h.sql }),
  getHarnessPg: () => ({ sql: h.sql }),
  pgbouncerEnabled: () => false,
}));

import { withTenantContext, type HostedTenantPrincipal, type VerifiedTenantServerContext } from './tenant-context';

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'tenantctx',
    provision: async (url) => {
      const setup = postgres(url, { max: 1, onnotice: () => {} });
      try {
        // Roles are cluster-wide and other suites share this cluster, so create
        // only if absent and tolerate a concurrent creator.
        await setup.unsafe(`
          DO $$
          BEGIN
            CREATE ROLE hosted_app NOLOGIN NOINHERIT;
          EXCEPTION WHEN duplicate_object THEN NULL;
          END $$;
        `);
        // Mirrors migration 997: the pool role may ASSUME hosted_app, and only
        // by assuming it — INHERIT FALSE is what keeps the privileges from
        // arriving ambiently on every ordinary query.
        await setup.unsafe(`GRANT hosted_app TO CURRENT_USER WITH INHERIT FALSE`);

        await setup`CREATE TABLE scratch (id int)`;
        await setup.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON scratch TO hosted_app`);

        // A tenant-owned table shaped like the real hosted tables: FORCE RLS so
        // even the owner is subject to policy, and every policy keyed on the
        // transaction-local organization GUC and granted TO hosted_app.
        await setup`
          CREATE TABLE tenant_rows (
            id              text PRIMARY KEY,
            organization_id text NOT NULL,
            secret          text NOT NULL
          )
        `;
        await setup.unsafe(`ALTER TABLE tenant_rows ENABLE ROW LEVEL SECURITY`);
        await setup.unsafe(`ALTER TABLE tenant_rows FORCE ROW LEVEL SECURITY`);
        await setup.unsafe(`
          GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_rows TO hosted_app
        `);
        for (const [name, command, clause] of [
          ['tenant_rows_app_select', 'SELECT', 'USING'],
          ['tenant_rows_app_update', 'UPDATE', 'USING'],
          ['tenant_rows_app_delete', 'DELETE', 'USING'],
        ] as const) {
          await setup.unsafe(`
            CREATE POLICY ${name} ON tenant_rows
              FOR ${command} TO hosted_app
              ${clause} (
                organization_id = NULLIF(current_setting('app.organization_id', true), '')
              )
          `);
        }
        await setup.unsafe(`
          CREATE POLICY tenant_rows_app_insert ON tenant_rows
            FOR INSERT TO hosted_app
            WITH CHECK (
              organization_id = NULLIF(current_setting('app.organization_id', true), '')
            )
        `);
      } finally {
        await setup.end({ timeout: 5 });
      }
    },
  });
  // More than one backend is required for the concurrency isolation proof.
  sql = postgres(db.url, { max: 4, onnotice: () => {} });
  h.sql = sql;
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

beforeEach(async () => {
  await sql`TRUNCATE scratch`;
  await sql`TRUNCATE tenant_rows`;
  await sql`
    INSERT INTO tenant_rows (id, organization_id, secret) VALUES
      ('row-a', 'org-a', 'tenant-a-secret'),
      ('row-b', 'org-b', 'tenant-b-secret')
  `;
});

function serverContext(suffix: string, selected = true): VerifiedTenantServerContext {
  const principal: HostedTenantPrincipal = {
    kind: 'user',
    profile: 'hosted',
    authMethod: 'cookie-session',
    trust: 'verified',
    slug: `user-${suffix}`,
    workspaceId: 'control-plane',
    userId: `user-${suffix}`,
    activeOrganizationId: `org-${suffix}`,
    ...(selected ? { selectedWorkspaceId: `customer-ws-${suffix}` } : {}),
    sessionId: `session-${suffix}`,
    sessionVersion: 1,
  };
  return {
    principal,
    ...(selected
      ? {
          selectedWorkspace: {
            id: `customer-ws-${suffix}`,
            organizationId: `org-${suffix}`,
          },
        }
      : {}),
  };
}

type GucRow = {
  user_id: string | null;
  organization_id: string | null;
  workspace_id: string | null;
};

const readTenantGucs = (tx: Sql) => tx<GucRow[]>`
  SELECT
    current_setting('app.user_id', true) AS user_id,
    current_setting('app.organization_id', true) AS organization_id,
    current_setting('app.workspace_id', true) AS workspace_id
`;

describe('withTenantContext', () => {
  it('sets verified user, organization, and selected customer workspace inside the transaction', async () => {
    const [inside] = await withTenantContext(serverContext('a'), readTenantGucs);
    expect(inside).toEqual({
      user_id: 'user-a',
      organization_id: 'org-a',
      workspace_id: 'customer-ws-a',
    });
    expect(inside.workspace_id).not.toBe('control-plane');
  });

  it('sets an explicit empty workspace GUC when no customer workspace is selected', async () => {
    const [inside] = await withTenantContext(serverContext('org-only', false), readTenantGucs);
    expect(inside).toEqual({
      user_id: 'user-org-only',
      organization_id: 'org-org-only',
      workspace_id: '',
    });
  });

  it('clears every tenant GUC after the transaction exits', async () => {
    await withTenantContext(serverContext('clear'), readTenantGucs);
    const [after] = await readTenantGucs(sql);
    expect(after.user_id == null || after.user_id === '').toBe(true);
    expect(after.organization_id == null || after.organization_id === '').toBe(true);
    expect(after.workspace_id == null || after.workspace_id === '').toBe(true);
  });

  it('rolls callback writes back when the transaction fails', async () => {
    await expect(
      withTenantContext(serverContext('rollback'), async (tx) => {
        await tx`INSERT INTO scratch (id) VALUES (1)`;
        throw new Error('tenant callback failed');
      }),
    ).rejects.toThrow('tenant callback failed');

    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM scratch`;
    expect(n).toBe(0);
    const [after] = await readTenantGucs(sql);
    expect(after.user_id == null || after.user_id === '').toBe(true);
    expect(after.organization_id == null || after.organization_id === '').toBe(true);
    expect(after.workspace_id == null || after.workspace_id === '').toBe(true);
  });

  it('isolates concurrent tenant transactions on the shared pool', async () => {
    const suffixes = Array.from({ length: 36 }, (_, index) => `concurrent-${index}`);
    const rows = await Promise.all(
      suffixes.map((suffix) =>
        withTenantContext(serverContext(suffix), async (tx) => {
          await tx`SELECT pg_sleep(0.01)`;
          const [row] = await readTenantGucs(tx);
          return row;
        }),
      ),
    );

    expect(rows).toHaveLength(suffixes.length);
    rows.forEach((row, index) => {
      const suffix = suffixes[index];
      expect(row).toEqual({
        user_id: `user-${suffix}`,
        organization_id: `org-${suffix}`,
        workspace_id: `customer-ws-${suffix}`,
      });
    });
  });
});

const readRole = (tx: Sql) => tx<{ current_user: string; session_user: string }[]>`
  SELECT current_user::text AS current_user, session_user::text AS session_user
`;

describe('withTenantContext hosted role', () => {
  it('runs the callback as hosted_app, not as the pool role', async () => {
    // This is what makes the FORCE RLS policies apply at all: every one of them
    // is granted TO hosted_app, and the pool connects as someone else.
    const [role] = await withTenantContext(serverContext('role'), readRole);

    expect(role.current_user).toBe('hosted_app');
    expect(role.session_user).not.toBe('hosted_app');
  });

  it('drops the hosted role when the transaction commits', async () => {
    const [inside] = await withTenantContext(serverContext('drop'), readRole);
    const [after] = await readRole(sql);

    expect(inside.current_user).toBe('hosted_app');
    // SET LOCAL is reverted at COMMIT, so a pooled connection is never handed to
    // the next caller still wearing the hosted role.
    expect(after.current_user).toBe(after.session_user);
    expect(after.current_user).not.toBe('hosted_app');
  });

  it('drops the hosted role when the callback throws', async () => {
    await expect(
      withTenantContext(serverContext('drop-throw'), async () => {
        throw new Error('tenant callback failed');
      }),
    ).rejects.toThrow('tenant callback failed');

    const [after] = await readRole(sql);
    expect(after.current_user).not.toBe('hosted_app');
  });

  it('gives every concurrent tenant transaction its own hosted role frame', async () => {
    const roles = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        withTenantContext(serverContext(`role-${index}`), async (tx) => {
          await tx`SELECT pg_sleep(0.01)`;
          const [row] = await readRole(tx);
          return row;
        }),
      ),
    );

    expect(roles.every((row) => row.current_user === 'hosted_app')).toBe(true);
    const [after] = await readRole(sql);
    expect(after.current_user).not.toBe('hosted_app');
  });
});

describe('withTenantContext tenant isolation', () => {
  const readTenantRows = (tx: Sql) => tx<{ id: string; secret: string }[]>`
    SELECT id, secret FROM tenant_rows ORDER BY id
  `;

  it('shows a tenant only its own rows', async () => {
    const visible = await withTenantContext(serverContext('a'), readTenantRows);
    expect(visible).toEqual([{ id: 'row-a', secret: 'tenant-a-secret' }]);
  });

  it('shows the other tenant only ITS own rows, from the same pool', async () => {
    const visible = await withTenantContext(serverContext('b'), readTenantRows);
    expect(visible).toEqual([{ id: 'row-b', secret: 'tenant-b-secret' }]);
  });

  it('cannot enumerate another tenant by guessing a primary key', async () => {
    const rows = await withTenantContext(
      serverContext('a'),
      (tx) => tx<{ id: string }[]>`SELECT id FROM tenant_rows WHERE id = 'row-b'`,
    );
    // Not an error — an empty result. The row is invisible, so its existence
    // does not leak through the difference between "denied" and "absent".
    expect(rows).toEqual([]);
  });

  it('cannot count another tenant\'s rows', async () => {
    const [{ n }] = await withTenantContext(
      serverContext('a'),
      (tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant_rows`,
    );
    expect(n).toBe(1);
  });

  it('cannot update another tenant\'s row', async () => {
    await withTenantContext(
      serverContext('a'),
      (tx) => tx`UPDATE tenant_rows SET secret = 'stolen' WHERE id = 'row-b'`,
    );

    const [row] = await sql<{ secret: string }[]>`
      SELECT secret FROM tenant_rows WHERE id = 'row-b'
    `;
    expect(row.secret).toBe('tenant-b-secret');
  });

  it('cannot delete another tenant\'s row', async () => {
    await withTenantContext(
      serverContext('a'),
      (tx) => tx`DELETE FROM tenant_rows WHERE id = 'row-b'`,
    );

    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM tenant_rows WHERE id = 'row-b'
    `;
    expect(n).toBe(1);
  });

  it('cannot insert a row into another tenant', async () => {
    await expect(
      withTenantContext(
        serverContext('a'),
        (tx) => tx`
          INSERT INTO tenant_rows (id, organization_id, secret)
          VALUES ('row-forged', 'org-b', 'forged')
        `,
      ),
    ).rejects.toThrow(/row-level security/i);

    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM tenant_rows WHERE id = 'row-forged'
    `;
    expect(n).toBe(0);
  });

  it('sees nothing at all without a tenant context', async () => {
    // The same pool, the same table, outside withTenantContext: the GUC is
    // unset, so the policy matches no row even for the table owner (FORCE RLS).
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM tenant_rows WHERE organization_id
        = NULLIF(current_setting('app.organization_id', true), '')
    `;
    expect(rows).toEqual([]);
  });
});
