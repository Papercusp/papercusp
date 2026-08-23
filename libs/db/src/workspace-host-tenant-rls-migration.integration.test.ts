/** Real-Postgres coverage for migration 908's existing workspace-host graph. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationSql(name: string): string {
  const armed = path.join(HERE, '..', 'sql', name);
  if (existsSync(armed)) return readFileSync(armed, 'utf8');
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return readFileSync(draft, 'utf8');
  throw new Error(`migration not found at ${armed}[.DRAFT]`);
}

const migrations = [
  migrationSql('887-workspace-host-observability.sql'),
  migrationSql('903-customer-organization-boundary.sql'),
  migrationSql('904-hosted-identity-links.sql'),
  migrationSql('906-customer-workspace-directory.sql'),
  migrationSql('907-hosted-customer-rls.sql'),
  migrationSql('908-workspace-host-tenant-rls.sql'),
];

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONTROL_A = 'control-a';
const CONTROL_B = 'control-b';
const CUSTOMER_A = 'customer-a';
const CUSTOMER_B = 'customer-b';

type RuntimeRole = 'hosted_app' | 'hosted_owner' | 'harness_app' | 'harness_zero';
type Scope = { organizationId?: string; workspaceId?: string };
type Counts = {
  connections: number;
  hosts: number;
  operations: number;
  resources: number;
  events: number;
  logs: number;
};

let db: MigratedTestDb;
let sql: Sql;

async function asRole<T>(role: RuntimeRole, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    return fn(tx);
  }) as Promise<T>;
}

async function setScope(tx: TransactionSql, scope: Scope): Promise<void> {
  if (scope.organizationId !== undefined) {
    await tx`SELECT set_config('app.organization_id', ${scope.organizationId}, true)`;
  }
  if (scope.workspaceId !== undefined) {
    await tx`SELECT set_config('app.workspace_id', ${scope.workspaceId}, true)`;
  }
}

async function counts(tx: TransactionSql): Promise<Counts> {
  const [row] = await tx<Counts[]>`
    SELECT
      (SELECT count(*)::int FROM harness_shared.workspace_host_connections) AS connections,
      (SELECT count(*)::int FROM harness_shared.workspace_hosts) AS hosts,
      (SELECT count(*)::int FROM harness_shared.workspace_host_operations) AS operations,
      (SELECT count(*)::int FROM harness_shared.workspace_host_resources) AS resources,
      (SELECT count(*)::int FROM harness_shared.workspace_host_events) AS events,
      (SELECT count(*)::int FROM harness_shared.workspace_host_logs) AS logs`;
  return row;
}

const ZERO: Counts = { connections: 0, hosts: 0, operations: 0, resources: 0, events: 0, logs: 0 };
const ONE: Counts = { connections: 1, hosts: 1, operations: 1, resources: 1, events: 1, logs: 1 };
const TWO: Counts = { connections: 2, hosts: 2, operations: 2, resources: 2, events: 2, logs: 2 };

async function seedTenant(control: string, customer: string, organization: string, suffix: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.workspace_host_connections
      (workspace_id, id, target, label, credential_ref, status)
    VALUES (${control}, ${`connection-${suffix}`}, 'gcp', ${`Connection ${suffix}`}, 'adc', 'connected')`;
  await sql`
    INSERT INTO harness_shared.workspace_hosts
      (workspace_id, id, name, connection_id, target, scope_label, region,
       size, image, disk_gib, network, desired_state, observed_state)
    VALUES
      (${control}, ${`host-${suffix}`}, ${`Host ${suffix}`}, ${`connection-${suffix}`},
       'gcp', 'project', 'us-central1', 'n2-standard-2', 'ubuntu-2404', 40,
       'default', 'running', 'running')`;
  await sql`
    INSERT INTO harness_shared.workspace_host_operations
      (workspace_id, id, host_id, action, status)
    VALUES (${control}, ${`operation-${suffix}`}, ${`host-${suffix}`}, 'provision', 'succeeded')`;
  await sql`
    INSERT INTO harness_shared.workspace_host_resources
      (workspace_id, host_id, logical_key, operation_id, state)
    VALUES (${control}, ${`host-${suffix}`}, 'vm', ${`operation-${suffix}`}, 'applied')`;
  await sql`
    INSERT INTO harness_shared.workspace_host_events
      (workspace_id, id, host_id, operation_id, phase, status, message)
    VALUES
      (${control}, ${`event-${suffix}`}, ${`host-${suffix}`}, ${`operation-${suffix}`},
       'provision', 'succeeded', 'complete')`;
  await sql`
    INSERT INTO harness_shared.workspace_host_logs
      (workspace_id, id, host_id, operation_id, stream, message)
    VALUES
      (${control}, ${`log-${suffix}`}, ${`host-${suffix}`}, ${`operation-${suffix}`},
       'controller', 'complete')`;
  await sql`
    INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name,
       state, created_by_principal_kind, created_by_principal_id)
    VALUES
      (${control}, ${customer}, ${organization}, ${`host-${suffix}`}, ${`Customer ${suffix}`},
       'active', 'user', ${`user-${suffix}`})`;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'hostgraph908' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });

  await sql.unsafe(`
    DO $roles$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
        CREATE ROLE harness_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN
        CREATE ROLE harness_zero NOLOGIN REPLICATION SUPERUSER;
      END IF;
    END
    $roles$;
    CREATE SCHEMA harness_shared;
    GRANT USAGE ON SCHEMA harness_shared TO harness_app, harness_zero;
    CREATE FUNCTION harness_shared.emit_change_notify()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RETURN COALESCE(NEW, OLD);
    END
    $$;
  `);

  for (const migration of migrations) await sql.unsafe(migration);
  await seedTenant(CONTROL_A, CUSTOMER_A, ORG_A, 'a');
  await seedTenant(CONTROL_B, CUSTOMER_B, ORG_B, 'b');
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 908 — workspace-host organization/workspace RLS', () => {
  it('is idempotent and forces every table under a safe non-runtime owner', async () => {
    await sql.unsafe(migrations[5]);
    const tables = await sql<{
      table_name: string;
      table_owner: string;
      row_security: boolean;
      force_row_security: boolean;
    }[]>`
      SELECT c.relname AS table_name, owner_role.rolname AS table_owner,
             c.relrowsecurity AS row_security,
             c.relforcerowsecurity AS force_row_security
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_roles owner_role ON owner_role.oid = c.relowner
       WHERE n.nspname = 'harness_shared'
         AND c.relname IN (
           'workspace_host_connections', 'workspace_hosts',
           'workspace_host_operations', 'workspace_host_resources',
           'workspace_host_events', 'workspace_host_logs'
         )
       ORDER BY c.relname`;

    expect(tables).toHaveLength(6);
    expect(tables.every((table) => table.table_owner === 'hosted_owner')).toBe(true);
    expect(tables.every((table) => table.row_security && table.force_row_security)).toBe(true);
    await expect(asRole('hosted_owner', counts)).resolves.toEqual(ZERO);
  });

  it('fails closed for unset, Stage-A-only, and foreign hosted context', async () => {
    await expect(asRole('hosted_app', counts)).resolves.toEqual(ZERO);

    const stageA = await asRole('hosted_app', async (tx) => {
      await setScope(tx, { workspaceId: CONTROL_A });
      return counts(tx);
    });
    expect(stageA).toEqual(ZERO);

    const foreign = await asRole('hosted_app', async (tx) => {
      await setScope(tx, { organizationId: ORG_A, workspaceId: CUSTOMER_B });
      return counts(tx);
    });
    expect(foreign).toEqual(ZERO);
  });

  it('exposes exactly the organization + selected customer-workspace host graph', async () => {
    const own = await asRole('hosted_app', async (tx) => {
      await setScope(tx, { organizationId: ORG_A, workspaceId: CUSTOMER_A });
      return counts(tx);
    });
    expect(own).toEqual(ONE);

    const deleted = await asRole('hosted_app', async (tx) => {
      await setScope(tx, { organizationId: ORG_A, workspaceId: CUSTOMER_A });
      return tx<{ id: string }[]>`
        DELETE FROM harness_shared.workspace_host_events
         WHERE id = 'event-b'
         RETURNING id`;
    });
    expect(deleted).toEqual([]);
  });

  it('keeps the explicit support-grant seam fail-closed until P-066 replaces it', async () => {
    const [row] = await sql<{ allowed: boolean }[]>`
      SELECT papercusp_auth.workspace_host_support_grant_allows(
        ${CONTROL_A}, 'host-a'
      ) AS allowed`;
    expect(row.allowed).toBe(false);

    const withInventedGrant = await asRole('hosted_app', async (tx) => {
      await tx`SELECT set_config('app.support_grant_id', 'invented', true)`;
      await tx`SELECT set_config('app.staff_actor_id', 'invented', true)`;
      return counts(tx);
    });
    expect(withInventedGrant).toEqual(ZERO);
  });

  it('preserves the local-profile workspace policy for read/write and zero-role reads', async () => {
    const local = await asRole('harness_app', async (tx) => {
      await setScope(tx, { workspaceId: CONTROL_A });
      await tx`
        UPDATE harness_shared.workspace_hosts
           SET name = 'Local profile update'
         WHERE id = 'host-a'`;
      return counts(tx);
    });
    expect(local).toEqual(ONE);

    const zero = await asRole('harness_zero', async (tx) => {
      await setScope(tx, { workspaceId: CONTROL_B });
      return counts(tx);
    });
    expect(zero).toEqual(TWO);
  });
});
