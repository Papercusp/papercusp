import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  path.join(HERE, '..', 'sql', '1013-hosted-workspace-lifecycle-policy.sql'),
  'utf8',
);

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'hostedlifecycle1013' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.workspace_hosts (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT 'gcp',
      observed_state TEXT NOT NULL DEFAULT 'running',
      PRIMARY KEY (workspace_id, id)
    );
    CREATE TABLE harness_shared.customer_workspaces (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      workspace_host_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY (workspace_id, id),
      UNIQUE (workspace_id, organization_id, id),
      FOREIGN KEY (workspace_id, workspace_host_id)
        REFERENCES harness_shared.workspace_hosts (workspace_id, id)
    );
    CREATE TABLE harness_shared.workspace_host_operations (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, id),
      FOREIGN KEY (workspace_id, host_id)
        REFERENCES harness_shared.workspace_hosts (workspace_id, id)
    );
  `);
  await sql.unsafe(migration);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

async function seed(): Promise<void> {
  await sql`
    INSERT INTO harness_shared.workspace_hosts (workspace_id, id)
    VALUES ('control-a', 'host-a') ON CONFLICT DO NOTHING`;
  await sql`
    INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id,
       billing_owner_kind, billing_owner_id, monthly_lifecycle_budget_cents)
    VALUES ('control-a', 'customer-a', 'org-a', 'host-a',
            'organization', 'org-a', 5000)
    ON CONFLICT DO NOTHING`;
}

describe('migration 1013 — hosted workspace lifecycle policy', () => {
  it('is idempotent and defaults concurrency policy without inventing a second queue', async () => {
    await sql.unsafe(migration);
    await seed();
    const [row] = await sql<Array<{
      tenant_concurrency_limit: number;
      provider_concurrency_limit: number;
      monthly_lifecycle_budget_cents: string;
    }>>`
      SELECT tenant_concurrency_limit, provider_concurrency_limit,
             monthly_lifecycle_budget_cents::text
      FROM harness_shared.customer_workspaces
      WHERE workspace_id = 'control-a' AND id = 'customer-a'`;
    expect(row).toEqual({
      tenant_concurrency_limit: 2,
      provider_concurrency_limit: 8,
      monthly_lifecycle_budget_cents: '5000',
    });
    const tables = await sql<Array<{ relname: string }>>`
      SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'harness_shared' AND c.relkind = 'r'
        AND relname LIKE '%lifecycle%job%'`;
    expect(tables).toEqual([]);
  });

  it('accepts a fully attributed job and rejects partial cost provenance', async () => {
    await seed();
    await sql`
      INSERT INTO harness_shared.workspace_host_operations
        (workspace_id, id, host_id, action, status,
         organization_id, customer_workspace_id, provider_target,
         estimated_cost_cents, cost_currency, cost_estimate_source,
         cost_estimate_ref, cost_estimated_at,
         billing_owner_kind, billing_owner_id, risk_tier, approval_status, heartbeat_at)
      VALUES
        ('control-a', 'op-good', 'host-a', 'start', 'queued',
         'org-a', 'customer-a', 'gcp', 1200, 'USD', 'gcp-catalog-v1',
         'gcp://catalog/e2-small', now(),
         'organization', 'org-a', 'moderate', 'not-required', now())`;

    await expect(sql`
      INSERT INTO harness_shared.workspace_host_operations
        (workspace_id, id, host_id, action, status,
         organization_id, customer_workspace_id, provider_target,
         estimated_cost_cents, cost_currency)
      VALUES
        ('control-a', 'op-partial', 'host-a', 'start', 'queued',
         'org-a', 'customer-a', 'gcp', 1200, 'USD')
    `).rejects.toThrow(/workspace_host_operations_cost_provenance_ck/);
  });

  it('allows only attributed destroy rows to carry the emergency bypass disposition', async () => {
    await seed();
    await expect(sql`
      INSERT INTO harness_shared.workspace_host_operations
        (workspace_id, id, host_id, action, status, emergency_teardown, teardown_reason)
      VALUES ('control-a', 'bad-emergency', 'start', 'start', 'queued', true, 'cleanup')
    `).rejects.toThrow();

    await sql`
      INSERT INTO harness_shared.workspace_host_operations
        (workspace_id, id, host_id, action, status,
         organization_id, customer_workspace_id, provider_target,
         billing_owner_kind, billing_owner_id,
         emergency_teardown, teardown_reason)
      VALUES
        ('control-a', 'good-emergency', 'host-a', 'destroy', 'queued',
         'org-a', 'customer-a', 'gcp', 'organization', 'org-a',
         true, 'credential revoked; remove orphaned resources')`;
  });

  it('enforces a complete approval writer and exact orphan timestamp state', async () => {
    await seed();
    await expect(sql`
      INSERT INTO harness_shared.workspace_host_operations
        (workspace_id, id, host_id, action, status,
         approval_status, approved_by_principal_id)
      VALUES ('control-a', 'bad-approval', 'host-a', 'start', 'queued', 'approved', 'owner-1')
    `).rejects.toThrow(/workspace_host_operations_approval_ck/);
    await expect(sql`
      INSERT INTO harness_shared.workspace_host_operations
        (workspace_id, id, host_id, action, status, recovery_state)
      VALUES ('control-a', 'bad-orphan', 'host-a', 'repair', 'queued', 'orphaned')
    `).rejects.toThrow(/workspace_host_operations_recovery_ck/);
  });
});
