/**
 * Migration 906 — hosted customer workspace directory and explicit grants.
 *
 * Runs the real migration against fresh Postgres. The checks pin the boundaries
 * that must be enforced in the database rather than by future hosted handlers:
 * one directory row per workspace-host identity, exactly one organization per
 * customer workspace, same-organization grants, non-wildcard authority, and a
 * retained/re-grantable grant lifecycle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '906-customer-workspace-directory.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 906 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

async function insertHost(workspaceId: string, hostId: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.workspace_hosts (workspace_id, id)
    VALUES (${workspaceId}, ${hostId})`;
}

async function insertCustomerWorkspace(args: {
  workspaceId: string;
  id: string;
  organizationId: string;
  hostId: string;
}): Promise<void> {
  await sql`
    INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name,
       state, created_by_principal_kind, created_by_principal_id)
    VALUES
      (${args.workspaceId}, ${args.id}, ${args.organizationId}, ${args.hostId},
       ${`Customer ${args.id}`}, 'active', 'user', 'user-owner')`;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'customerws906' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.workspace_hosts (
      workspace_id text NOT NULL,
      id text NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
  `);
  await sql.unsafe(migrationSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 906 — customer workspace directory', () => {
  it('is idempotent and creates only the two standalone directory tables', async () => {
    await sql.unsafe(migrationSql);
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'harness_shared'
         AND table_name IN ('customer_workspaces', 'workspace_grants')
       ORDER BY table_name`;
    expect(rows.map((row) => row.table_name)).toEqual([
      'customer_workspaces',
      'workspace_grants',
    ]);
  });

  it('requires an existing workspace-host and maps each host to one organization', async () => {
    await insertHost('ws-host-link', 'host-1');
    await insertCustomerWorkspace({
      workspaceId: 'ws-host-link',
      id: 'customer-1',
      organizationId: 'org-a',
      hostId: 'host-1',
    });

    await expect(insertCustomerWorkspace({
      workspaceId: 'ws-host-link',
      id: 'customer-2',
      organizationId: 'org-b',
      hostId: 'host-1',
    })).rejects.toThrow(/customer_workspaces_host_identity_uq|duplicate key/i);

    await expect(insertCustomerWorkspace({
      workspaceId: 'ws-host-link',
      id: 'customer-missing-host',
      organizationId: 'org-a',
      hostId: 'host-missing',
    })).rejects.toThrow(/customer_workspaces_host_fk|foreign key/i);

    await expect(sql`
      INSERT INTO harness_shared.customer_workspaces
        (workspace_id, id, organization_id, workspace_host_id, display_name,
         created_by_principal_kind, created_by_principal_id)
      VALUES
        ('ws-host-link', 'customer-blank-org', '', 'host-1', 'Blank org',
         'user', 'user-owner')
    `).rejects.toThrow(/customer_workspaces_organization_id_ck/i);
  });

  it('binds every grant to the customer workspace organization and rejects wildcards', async () => {
    await insertHost('ws-grants', 'host-1');
    await insertCustomerWorkspace({
      workspaceId: 'ws-grants',
      id: 'customer-1',
      organizationId: 'org-a',
      hostId: 'host-1',
    });

    await sql`
      INSERT INTO harness_shared.workspace_grants
        (workspace_id, id, organization_id, customer_workspace_id,
         grantee_kind, grantee_id, permission,
         granted_by_principal_kind, granted_by_principal_id)
      VALUES
        ('ws-grants', 'grant-1', 'org-a', 'customer-1',
         'user', 'user-member', 'workspace.view', 'user', 'user-owner')`;

    await expect(sql`
      INSERT INTO harness_shared.workspace_grants
        (workspace_id, id, organization_id, customer_workspace_id,
         grantee_kind, grantee_id, permission,
         granted_by_principal_kind, granted_by_principal_id)
      VALUES
        ('ws-grants', 'grant-wrong-org', 'org-b', 'customer-1',
         'user', 'user-member', 'workspace.view', 'user', 'user-owner')
    `).rejects.toThrow(/workspace_grants_workspace_fk|foreign key/i);

    await expect(sql`
      INSERT INTO harness_shared.workspace_grants
        (workspace_id, id, organization_id, customer_workspace_id,
         grantee_kind, grantee_id, permission,
         granted_by_principal_kind, granted_by_principal_id)
      VALUES
        ('ws-grants', 'grant-wildcard', 'org-a', 'customer-1',
         'user', 'user-other', 'workspace.*', 'user', 'user-owner')
    `).rejects.toThrow(/workspace_grants_permission_ck/i);

    await expect(sql`
      INSERT INTO harness_shared.workspace_grants
        (workspace_id, id, organization_id, customer_workspace_id,
         grantee_kind, grantee_id, permission,
         granted_by_principal_kind, granted_by_principal_id)
      VALUES
        ('ws-grants', 'grant-duplicate', 'org-a', 'customer-1',
         'user', 'user-member', 'workspace.view', 'user', 'user-owner')
    `).rejects.toThrow(/workspace_grants_active_uq|duplicate key/i);
  });

  it('retains explicit terminal evidence and permits a fresh grant after revocation', async () => {
    await insertHost('ws-lifecycle', 'host-1');
    await insertCustomerWorkspace({
      workspaceId: 'ws-lifecycle',
      id: 'customer-1',
      organizationId: 'org-a',
      hostId: 'host-1',
    });

    await sql`
      INSERT INTO harness_shared.workspace_grants
        (workspace_id, id, organization_id, customer_workspace_id,
         grantee_kind, grantee_id, permission,
         granted_by_principal_kind, granted_by_principal_id)
      VALUES
        ('ws-lifecycle', 'grant-original', 'org-a', 'customer-1',
         'user', 'user-member', 'workspace.operate', 'user', 'user-owner')`;

    await expect(sql`
      UPDATE harness_shared.workspace_grants
         SET state = 'revoked', revoked_at = now()
       WHERE workspace_id = 'ws-lifecycle' AND id = 'grant-original'
    `).rejects.toThrow(/workspace_grants_lifecycle_ck/i);

    await sql`
      UPDATE harness_shared.workspace_grants
         SET state = 'revoked',
             revoked_at = now(),
             revoked_by_principal_kind = 'user',
             revoked_by_principal_id = 'user-owner',
             revocation_reason = 'membership removed'
       WHERE workspace_id = 'ws-lifecycle' AND id = 'grant-original'`;

    await expect(sql`
      INSERT INTO harness_shared.workspace_grants
        (workspace_id, id, organization_id, customer_workspace_id,
         grantee_kind, grantee_id, permission,
         granted_by_principal_kind, granted_by_principal_id)
      VALUES
        ('ws-lifecycle', 'grant-reissued', 'org-a', 'customer-1',
         'user', 'user-member', 'workspace.operate', 'user', 'user-owner')
    `).resolves.not.toThrow();

    await expect(sql`
      INSERT INTO harness_shared.workspace_grants
        (workspace_id, id, organization_id, customer_workspace_id,
         grantee_kind, grantee_id, permission, state,
         granted_by_principal_kind, granted_by_principal_id,
         expires_at)
      VALUES
        ('ws-lifecycle', 'grant-bad-expiry', 'org-a', 'customer-1',
         'user', 'user-expiring', 'workspace.view', 'expired',
         'user', 'user-owner', now() + interval '1 day')
    `).rejects.toThrow(/workspace_grants_lifecycle_ck/i);

    await expect(sql`
      INSERT INTO harness_shared.workspace_grants
        (workspace_id, id, organization_id, customer_workspace_id,
         grantee_kind, grantee_id, permission, state,
         granted_by_principal_kind, granted_by_principal_id,
         expires_at, expired_at)
      VALUES
        ('ws-lifecycle', 'grant-expired', 'org-a', 'customer-1',
         'user', 'user-expired', 'workspace.view', 'expired',
         'user', 'user-owner', now() + interval '1 day', now())
    `).resolves.not.toThrow();
  });

  it('does not admit credential or wildcard-authority columns', async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name IN ('customer_workspaces', 'workspace_grants')`;
    expect(rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining([
        'password', 'password_hash', 'password_reset_token', 'mfa_secret',
        'credential', 'credential_ref', 'capabilities',
      ]),
    );
  });
});
