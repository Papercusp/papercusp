/**
 * Migration 903 — hosted customer organization boundary.
 *
 * Runs the real migration against fresh Postgres. The empty prerequisite schema
 * is intentional: P-076 must remain independently runnable from the concurrent
 * identity and workspace-directory leaves. These tests pin multi-organization
 * membership, local-only role authority, organization-safe invitation linking,
 * lifecycle checks, dedupe, idempotency, and the no-identity-secrets boundary.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '903-customer-organization-boundary.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 903 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

async function createOrganization(externalId: string, name: string): Promise<string> {
  const [organization] = await sql<{ id: string }[]>`
    INSERT INTO papercusp_auth.organizations
      (identity_provider, external_organization_id, display_name)
    VALUES ('workos', ${externalId}, ${name})
    RETURNING id`;
  return organization.id;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'org-boundary903' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(migrationSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 903 — hosted customer organization boundary', () => {
  it('is independently runnable and idempotently creates exactly its three relations', async () => {
    await sql.unsafe(migrationSql);

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'papercusp_auth'
       ORDER BY table_name`;

    expect(tables.map((row) => row.table_name)).toEqual([
      'organization_invitation_refs',
      'organization_memberships',
      'organizations',
    ]);
  });

  it('maps each external organization once and requires lifecycle timestamps', async () => {
    await createOrganization('org-external-unique', 'Acme');

    await expect(createOrganization('org-external-unique', 'Duplicate Acme')).rejects.toThrow(
      /organizations_external_identity_uq/,
    );

    await expect(sql`
      INSERT INTO papercusp_auth.organizations
        (external_organization_id, display_name, status)
      VALUES ('org-suspended-without-time', 'Suspended', 'suspended')
    `).rejects.toThrow(/organizations_suspended_at_ck/);
  });

  it('allows one user in many organizations but one lifecycle row per user/org', async () => {
    const orgA = await createOrganization('org-multi-a', 'Multi A');
    const orgB = await createOrganization('org-multi-b', 'Multi B');

    await sql`
      INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, created_via)
      VALUES
        (${orgA}, ${USER_A}::uuid, 'owner', 'organization_bootstrap'),
        (${orgB}, ${USER_A}::uuid, 'member', 'member_management')`;

    const memberships = await sql<{ organization_id: string }[]>`
      SELECT organization_id
        FROM papercusp_auth.organization_memberships
       WHERE user_id = ${USER_A}::uuid
       ORDER BY organization_id`;
    expect(memberships).toHaveLength(2);

    await expect(sql`
      INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, created_via)
      VALUES (${orgA}, ${USER_A}::uuid, 'admin', 'member_management')
    `).rejects.toThrow(/organization_memberships_org_user_uq/);
  });

  it('makes Papercusp the only grant authority and rejects external role writes', async () => {
    const org = await createOrganization('org-local-authority', 'Local Authority');

    await expect(sql`
      INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, authority, created_via)
      VALUES (${org}, ${USER_B}::uuid, 'admin', 'workos', 'member_management')
    `).rejects.toThrow(/organization_memberships_authority_ck/);

    await expect(sql`
      INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, created_via)
      VALUES (${org}, ${USER_B}::uuid, 'superadmin', 'member_management')
    `).rejects.toThrow(/organization_memberships_role_ck/);
  });

  it('dedupes provider invitations and cannot apply one across organizations', async () => {
    const orgA = await createOrganization('org-invite-a', 'Invite A');
    const orgB = await createOrganization('org-invite-b', 'Invite B');

    const [invitation] = await sql<{ id: string }[]>`
      INSERT INTO papercusp_auth.organization_invitation_refs
        (organization_id, identity_provider, external_invitation_id,
         invitee_email, intended_role, status, accepted_by_user_id, accepted_at)
      VALUES (
        ${orgA}, 'workos', 'inv-external-1', 'member@example.com',
        'member', 'accepted', ${USER_B}::uuid, now()
      )
      RETURNING id`;

    await expect(sql`
      INSERT INTO papercusp_auth.organization_invitation_refs
        (organization_id, identity_provider, external_invitation_id, invitee_email)
      VALUES (${orgB}, 'workos', 'inv-external-1', 'other@example.com')
    `).rejects.toThrow(/organization_invitation_refs_external_identity_uq/);

    await expect(sql`
      INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, created_via, invitation_ref_id)
      VALUES (
        ${orgB}, ${USER_B}::uuid, 'member', 'invitation_acceptance', ${invitation.id}
      )
    `).rejects.toThrow(/organization_memberships_invitation_org_fk/);

    await sql`
      INSERT INTO papercusp_auth.organization_memberships
        (organization_id, user_id, role, created_via, invitation_ref_id)
      VALUES (
        ${orgA}, ${USER_B}::uuid, 'member', 'invitation_acceptance', ${invitation.id}
      )`;
  });

  it('stores no password, recovery, MFA, credential, token, or secret columns', async () => {
    const forbidden = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'papercusp_auth'
         AND table_name IN (
           'organizations',
           'organization_invitation_refs',
           'organization_memberships'
         )
         AND column_name ~ '(password|passcode|hash|secret|token|credential|mfa)'
       ORDER BY table_name, column_name`;

    expect(forbidden).toEqual([]);
  });
});
