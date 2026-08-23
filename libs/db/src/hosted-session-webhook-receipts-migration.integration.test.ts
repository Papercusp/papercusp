/**
 * Migration 902 — revocable hosted sessions and signed webhook receipts.
 *
 * The migration is a parallel-safe leaf, so this focused rig deliberately
 * applies it to a fresh database without any other Papercusp migrations.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '902-hosted-session-webhook-receipts.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 902 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'hosted902' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(migrationSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 902 — hosted sessions', () => {
  it('is standalone and idempotent', async () => {
    await sql.unsafe(migrationSql);

    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'papercusp_auth'
       ORDER BY table_name`;
    expect(tables.map((row) => row.table_name)).toEqual([
      'hosted_sessions',
      'webhook_event_receipts',
    ]);
  });

  it('persists explicit tenant, upstream-session, permission, and revocation metadata', async () => {
    const [session] = await sql<{
      permission_version: string;
      revoked_at: Date | null;
    }[]>`
      INSERT INTO papercusp_auth.hosted_sessions (
        id, user_id, organization_id, workspace_id, permission_version,
        upstream_provider, upstream_session_id, expires_at
      ) VALUES (
        'session-a', 'user-a', 'org-a', 'workspace-a', 7,
        'workos', 'workos-session-a', now() + interval '1 hour'
      )
      RETURNING permission_version, revoked_at`;
    expect(Number(session.permission_version)).toBe(7);
    expect(session.revoked_at).toBeNull();

    await sql`
      UPDATE papercusp_auth.hosted_sessions
         SET revoked_at = now(),
             revocation_reason = 'upstream-session-revoked',
             updated_at = now()
       WHERE id = 'session-a'`;

    const [revoked] = await sql<{ revoked: boolean; reason: string }[]>`
      SELECT revoked_at IS NOT NULL AS revoked, revocation_reason AS reason
        FROM papercusp_auth.hosted_sessions
       WHERE id = 'session-a'`;
    expect(revoked).toEqual({ revoked: true, reason: 'upstream-session-revoked' });
  });

  it('rejects duplicate upstream sessions and invalid authorization lifetimes', async () => {
    await expect(sql`
      INSERT INTO papercusp_auth.hosted_sessions (
        id, user_id, organization_id, permission_version,
        upstream_provider, upstream_session_id, expires_at
      ) VALUES (
        'session-duplicate', 'user-a', 'org-a', 7,
        'workos', 'workos-session-a', now() + interval '1 hour'
      )
    `).rejects.toThrow(/hosted_sessions_upstream_session_key/);

    await expect(sql`
      INSERT INTO papercusp_auth.hosted_sessions (
        id, user_id, organization_id, permission_version,
        upstream_provider, upstream_session_id, expires_at
      ) VALUES (
        'session-invalid-version', 'user-a', 'org-a', -1,
        'workos', 'workos-session-b', now() + interval '1 hour'
      )
    `).rejects.toThrow(/permission_version/);

    await expect(sql`
      INSERT INTO papercusp_auth.hosted_sessions (
        id, user_id, organization_id,
        upstream_provider, upstream_session_id, expires_at
      ) VALUES (
        'session-expired-at-create', 'user-a', 'org-a',
        'workos', 'workos-session-c', now() - interval '1 hour'
      )
    `).rejects.toThrow(/hosted_sessions_expiry_after_create/);
  });
});

describe('migration 902 — signed webhook receipts', () => {
  const digest = 'a'.repeat(64);

  it('deduplicates verified provider events and retains version ordering inputs', async () => {
    const [receipt] = await sql<{
      event_version: string;
      status: string;
      attempt_count: number;
    }[]>`
      INSERT INTO papercusp_auth.webhook_event_receipts (
        provider, event_id, event_type, provider_account_id, subject_ref,
        event_version, event_created_at, payload, payload_sha256,
        signature_key_ref, retention_until
      ) VALUES (
        'workos', 'event-a', 'session.revoked', 'account-a', 'session-a',
        '2026-08-23T06:00:00Z', '2026-08-23T06:00:00Z',
        ${JSON.stringify({ id: 'event-a', event: 'session.revoked' })}::text::jsonb, ${digest},
        'workos-secret-v2', now() + interval '90 days'
      )
      RETURNING event_version, status, attempt_count`;
    expect(receipt).toEqual({
      event_version: '2026-08-23T06:00:00Z',
      status: 'queued',
      attempt_count: 0,
    });

    await expect(sql`
      INSERT INTO papercusp_auth.webhook_event_receipts (
        provider, event_id, event_type, event_created_at, payload,
        payload_sha256, retention_until
      ) VALUES (
        'workos', 'event-a', 'session.revoked', now(),
        ${JSON.stringify({ id: 'event-a' })}::text::jsonb, ${digest}, now() + interval '90 days'
      )
    `).rejects.toThrow(/webhook_event_receipts_pkey/);
  });

  it('requires a verified payload digest and a terminal processing timestamp', async () => {
    await expect(sql`
      INSERT INTO papercusp_auth.webhook_event_receipts (
        provider, event_id, event_type, event_created_at, payload,
        payload_sha256, retention_until
      ) VALUES (
        'workos', 'event-bad-digest', 'user.updated', now(),
        ${JSON.stringify({ id: 'event-bad-digest' })}::text::jsonb, 'not-a-sha256',
        now() + interval '90 days'
      )
    `).rejects.toThrow(/webhook_event_receipts_payload_digest/);

    await expect(sql`
      INSERT INTO papercusp_auth.webhook_event_receipts (
        provider, event_id, event_type, event_created_at, payload,
        payload_sha256, status, retention_until
      ) VALUES (
        'workos', 'event-missing-processed-at', 'user.updated', now(),
        ${JSON.stringify({ id: 'event-missing-processed-at' })}::text::jsonb, ${digest}, 'applied',
        now() + interval '90 days'
      )
    `).rejects.toThrow(/webhook_event_receipts_terminal_timestamp/);
  });

  it('installs active-session, queue, subject-ordering, and retention indexes', async () => {
    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
        FROM pg_indexes
       WHERE schemaname = 'papercusp_auth'
         AND indexname IN (
           'hosted_sessions_expiry_idx',
           'hosted_sessions_user_active_idx',
           'webhook_event_receipts_queue_idx',
           'webhook_event_receipts_subject_version_idx',
           'webhook_event_receipts_retention_idx'
         )
       ORDER BY indexname`;
    expect(indexes.map((row) => row.indexname)).toEqual([
      'hosted_sessions_expiry_idx',
      'hosted_sessions_user_active_idx',
      'webhook_event_receipts_queue_idx',
      'webhook_event_receipts_retention_idx',
      'webhook_event_receipts_subject_version_idx',
    ]);
    expect(indexes.every((row) => / WHERE /.test(row.indexdef))).toBe(true);
  });
});
