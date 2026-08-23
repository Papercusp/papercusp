/**
 * Real-Postgres proof for the hosted tenant transaction wrapper: all GUCs are
 * transaction-local, concurrent callers cannot observe each other's scope, and
 * callback failure rolls back both data and context.
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
        await setup`CREATE TABLE scratch (id int)`;
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
