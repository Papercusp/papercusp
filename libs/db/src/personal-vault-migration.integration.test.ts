/**
 * Migration 874 — Personal Vault schema and privacy invariants.
 *
 * Exercises the migration itself against a fresh Postgres rather than merely
 * matching SQL text: idempotency, workspace RLS, document dedupe, grant shape,
 * identity aliases, and the local-only embedding-mode fence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '874-personal-vault.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 874 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;
let userId: string;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'personal874' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA harness_shared');
  await sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await sql.unsafe(`
    CREATE TABLE harness_shared.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      username text NOT NULL UNIQUE
    )`);
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username) VALUES ('owner') RETURNING id`;
  userId = user.id;
  await sql.unsafe(migrationSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 874 — Personal Vault', () => {
  it('is idempotent and creates every vault table', async () => {
    await sql.unsafe(migrationSql);
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'harness_shared'
         AND table_name LIKE 'personal_%'
       ORDER BY table_name`;
    expect(rows.map((r) => r.table_name)).toEqual([
      'personal_documents',
      'personal_grants',
      'personal_identities',
      'personal_identity_aliases',
      'personal_sync_state',
      'personal_vault_settings',
    ]);
  });

  it('dedupes documents per workspace/user/source and derives the personal scope key', async () => {
    const [row] = await sql<{ scope_key: string }[]>`
      INSERT INTO harness_shared.personal_documents
        (workspace_id, user_id, source, kind, external_id, title, text, dedupe_key)
      VALUES ('ws-a', ${userId}, 'gmail', 'message', 'm-1', 'Subject', 'Body', 'gmail:m-1')
      RETURNING scope_key`;
    expect(row.scope_key).toBe('personal:gmail');
    await expect(sql`
      INSERT INTO harness_shared.personal_documents
        (workspace_id, user_id, source, kind, dedupe_key)
      VALUES ('ws-a', ${userId}, 'gmail', 'message', 'gmail:m-1')
    `).rejects.toThrow(/personal_documents_workspace_id_user_id_source_dedupe_key_key/);
  });

  it('rejects any cloud embedding-mode stamp at the database boundary', async () => {
    await expect(sql`
      INSERT INTO harness_shared.personal_documents
        (workspace_id, user_id, source, kind, dedupe_key, embedding_mode)
      VALUES ('ws-a', ${userId}, 'calendar', 'event', 'gcal:e-1', 'openai')
    `).rejects.toThrow(/personal_documents_embedding_mode_check/);

    await sql`
      INSERT INTO harness_shared.personal_documents
        (workspace_id, user_id, source, kind, dedupe_key, embedding_mode)
      VALUES ('ws-a', ${userId}, 'calendar', 'event', 'gcal:e-2', 'gemma')`;
  });

  it('enforces the grant principal taxonomy and retains revocable grant rows', async () => {
    const [grant] = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.personal_grants
        (workspace_id, user_id, principal_type, principal_id, scopes, granted_by)
      VALUES ('ws-a', ${userId}, 'plan-template', 'meeting-prep-brief',
              ARRAY['personal:gmail'], 'owner')
      RETURNING id`;
    await sql`
      UPDATE harness_shared.personal_grants SET revoked_at = now()
       WHERE workspace_id = 'ws-a' AND user_id = ${userId} AND id = ${grant.id}`;
    await sql`
      INSERT INTO harness_shared.personal_grants
        (workspace_id, user_id, principal_type, principal_id, scopes, granted_by)
      VALUES ('ws-a', ${userId}, 'plan-template', 'meeting-prep-brief',
              ARRAY['personal:gmail'], 'owner')`;

    await expect(sql`
      INSERT INTO harness_shared.personal_grants
        (workspace_id, user_id, principal_type, principal_id, scopes, granted_by)
      VALUES ('ws-a', ${userId}, 'self-declared', 'anything',
              ARRAY['personal:gmail'], 'agent')
    `).rejects.toThrow(/personal_grants_principal_type_check/);
  });

  it('maps source aliases to one canonical identity and refuses duplicate aliases', async () => {
    const [identity] = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.personal_identities
        (workspace_id, user_id, display_name, primary_email)
      VALUES ('ws-a', ${userId}, 'Ada Lovelace', 'ada@example.com')
      RETURNING id`;
    await sql`
      INSERT INTO harness_shared.personal_identity_aliases
        (workspace_id, user_id, identity_id, source, alias_kind, normalized_value, display_value)
      VALUES ('ws-a', ${userId}, ${identity.id}, 'gmail', 'email',
              'ada@example.com', 'Ada <ada@example.com>')`;
    // PostgreSQL truncates generated identifier names at 63 bytes.
    await expect(sql`
      INSERT INTO harness_shared.personal_identity_aliases
        (workspace_id, user_id, identity_id, source, alias_kind, normalized_value)
      VALUES ('ws-a', ${userId}, ${identity.id}, 'gmail', 'email', 'ada@example.com')
    `).rejects.toThrow(/personal_identity_aliases_workspace_id_user_id_source_alias_key/);
  });

  it('installs a workspace-isolation RLS policy on every vault table', async () => {
    const rows = await sql<{ tablename: string }[]>`
      SELECT tablename
        FROM pg_policies
       WHERE schemaname = 'harness_shared'
         AND tablename LIKE 'personal_%'
       ORDER BY tablename`;
    expect(rows.map((r) => r.tablename)).toEqual([
      'personal_documents',
      'personal_grants',
      'personal_identities',
      'personal_identity_aliases',
      'personal_sync_state',
      'personal_vault_settings',
    ]);
  });
});
