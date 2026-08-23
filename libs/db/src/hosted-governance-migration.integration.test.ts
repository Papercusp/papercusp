/** Fresh-Postgres contract for migration 907 (BYOC P-088 / WI-40864). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const STAFF = 'staff:case-42';

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '907-hosted-governance.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 907 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'hosted-governance907' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(migrationSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 907 — hosted governance', () => {
  it('is independently runnable and idempotently creates the four leaf tables', async () => {
    await sql.unsafe(migrationSql);
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'papercusp_auth'
       ORDER BY table_name`;
    expect(rows.map((row) => row.table_name)).toEqual([
      'hosted_user_preferences',
      'legal_acceptances',
      'organization_audit_events',
      'support_access_grants',
    ]);
  });

  it('deduplicates versioned legal acceptance and forbids mutation/deletion', async () => {
    const [accepted] = await sql<{ id: string }[]>`
      INSERT INTO papercusp_auth.legal_acceptances (
        organization_id, user_id, document_kind, document_version,
        acceptance_source, evidence
      ) VALUES (${ORG}::uuid, ${USER}::uuid, 'terms', '2026-08-23', 'hosted_ui', ${{ screen: 'signup' }})
      RETURNING id`;

    await expect(sql`
      INSERT INTO papercusp_auth.legal_acceptances (
        organization_id, user_id, document_kind, document_version, acceptance_source
      ) VALUES (${ORG}::uuid, ${USER}::uuid, 'terms', '2026-08-23', 'api')
    `).rejects.toThrow(/legal_acceptances_version_uq/);
    await expect(sql`
      UPDATE papercusp_auth.legal_acceptances SET document_version = 'changed'
       WHERE id = ${accepted.id}::uuid
    `).rejects.toThrow(/append-only/);
    await expect(sql`
      DELETE FROM papercusp_auth.legal_acceptances WHERE id = ${accepted.id}::uuid
    `).rejects.toThrow(/append-only/);
  });

  it('keeps audit history tenant-scoped, append-only, and secret-free', async () => {
    const [event] = await sql<{ id: string }[]>`
      INSERT INTO papercusp_auth.organization_audit_events (
        organization_id, actor_kind, actor_id, action, purpose, metadata
      ) VALUES (
        ${ORG}::uuid, 'staff_admin', ${STAFF}, 'support.grant.created',
        'Case 42 diagnosis', ${{ caseRef: 'case-42' }}
      ) RETURNING id`;

    await expect(sql`
      UPDATE papercusp_auth.organization_audit_events SET action = 'rewritten'
       WHERE id = ${event.id}::uuid
    `).rejects.toThrow(/append-only/);
    await expect(sql`
      INSERT INTO papercusp_auth.organization_audit_events (
        organization_id, actor_kind, actor_id, action, purpose, metadata
      ) VALUES (
        ${ORG}::uuid, 'staff_admin', ${STAFF}, 'unsafe', 'unsafe payload',
        ${{ nested: { access_token: 'do-not-store' } }}
      )
    `).rejects.toThrow(/organization_audit_events_metadata_safe_ck/);
  });

  it('requires visible, scoped, expiring support access and permits only one revocation', async () => {
    await expect(sql`
      INSERT INTO papercusp_auth.support_access_grants (
        organization_id, staff_principal_id, granted_by_user_id,
        purpose, scopes, banner_message, expires_at
      ) VALUES (
        ${ORG}::uuid, ${STAFF}, ${USER}::uuid, 'Overbroad', ARRAY['*'],
        'Support access active', now() + interval '1 hour'
      )
    `).rejects.toThrow(/support_access_grants_scopes_ck/);

    const [grant] = await sql<{ id: string }[]>`
      INSERT INTO papercusp_auth.support_access_grants (
        organization_id, staff_principal_id, granted_by_user_id,
        purpose, scopes, banner_message, expires_at
      ) VALUES (
        ${ORG}::uuid, ${STAFF}, ${USER}::uuid, 'Case 42 diagnosis',
        ARRAY['workspace:read', 'logs:read'],
        'Papercusp support has temporary access for case 42.',
        now() + interval '1 hour'
      ) RETURNING id`;

    const active = await sql<{ banner_message: string }[]>`
      SELECT banner_message FROM papercusp_auth.support_access_grants
       WHERE organization_id = ${ORG}::uuid
         AND starts_at <= now() AND expires_at > now() AND revoked_at IS NULL`;
    expect(active).toEqual([
      { banner_message: 'Papercusp support has temporary access for case 42.' },
    ]);

    await expect(sql`
      UPDATE papercusp_auth.support_access_grants SET purpose = 'rewritten'
       WHERE id = ${grant.id}::uuid
    `).rejects.toThrow(/only be updated to revoke/);

    await sql`
      UPDATE papercusp_auth.support_access_grants
         SET revoked_at = now(), revoked_by_user_id = ${USER}::uuid,
             revocation_reason = 'Customer revoked', updated_at = now()
       WHERE id = ${grant.id}::uuid`;
    await expect(sql`
      UPDATE papercusp_auth.support_access_grants
         SET revocation_reason = 'rewritten' WHERE id = ${grant.id}::uuid
    `).rejects.toThrow(/revocation is immutable/);
  });

  it('stores organization-scoped profile, locale, timezone, and notification preferences', async () => {
    await sql`
      INSERT INTO papercusp_auth.hosted_user_preferences (
        organization_id, user_id, locale, time_zone, profile, notification_preferences
      ) VALUES (
        ${ORG}::uuid, ${USER}::uuid, 'en-US', 'America/New_York',
        ${{ displayName: 'Avi' }}, ${{ productUpdates: false, security: true }}
      )`;
    const rows = await sql<{ locale: string; time_zone: string }[]>`
      SELECT locale, time_zone FROM papercusp_auth.hosted_user_preferences
       WHERE organization_id = ${ORG}::uuid AND user_id = ${USER}::uuid`;
    expect(rows).toEqual([{ locale: 'en-US', time_zone: 'America/New_York' }]);

    await expect(sql`
      UPDATE papercusp_auth.hosted_user_preferences
         SET notification_preferences = ${{ webhookSecret: 'do-not-store' }}
       WHERE organization_id = ${ORG}::uuid AND user_id = ${USER}::uuid
    `).rejects.toThrow(/hosted_user_preferences_notifications_safe_ck/);
  });
});
