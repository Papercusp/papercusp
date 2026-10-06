/**
 * Migration 1414 — the Personal Vault mail partition is provider-neutral
 * (`gmail` -> `mail`, scope `personal:gmail` -> `personal:mail`; WI-10006490).
 *
 * Applies the real 874 + 1357 + 1414 SQL over legacy rows and proves:
 *   - every stored name moves (documents source + dedupe key, the generated
 *     scope_key, grants, sync state, identity aliases) and nothing else does;
 *   - a pre-existing `mail` twin wins over its legacy row, and two live grants
 *     that converge on one scope set leave exactly one live grant;
 *   - a write in the LEGACY shape (what the older release on :3070 still sends
 *     during the expand window) lands in the renamed partition — an upsert
 *     conflicts with the renamed row instead of minting a twin;
 *   - re-applying the migration is a no-op.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(filename: string): string {
  const armed = path.join(HERE, '..', 'sql', filename);
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration not found at ${armed}[.DRAFT]`);
}

const personalVaultSql = readFileSync(migrationPath('874-personal-vault.sql'), 'utf8');
const datatypeSql = readFileSync(migrationPath('1357-documents-datatype-id.sql'), 'utf8');
const mailPartitionSql = readFileSync(migrationPath('1414-vault-mail-partition.sql'), 'utf8');

const OWNER = '11111111-1111-4111-8111-111111111111';
const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS = 'ws-mail';
const ACCOUNT = `account:${createHash('sha256').update('owner@example.com').digest('hex')}:`;

let db: MigratedTestDb;
let sql: Sql;

async function insertDoc(source: string, dedupeKey: string, externalId: string, kind = 'message'): Promise<void> {
  await sql`
    INSERT INTO harness_shared.documents
      (workspace_id, user_id, source, kind, external_id, title, dedupe_key, source_id, datatype_id)
    VALUES (${WS}, ${OWNER}::uuid, ${source}, ${kind}, ${externalId}, ${externalId}, ${dedupeKey},
            ${SOURCE}::uuid, ${source === 'calendar' ? 'calendar-event' : 'email-message'})`;
}

async function docs(): Promise<Array<{ source: string; scope_key: string; dedupe_key: string; title: string; datatype_id: string | null }>> {
  return sql`
    SELECT source, scope_key, dedupe_key, title, datatype_id
      FROM harness_shared.documents
     WHERE workspace_id = ${WS}
     ORDER BY dedupe_key`;
}

async function grants(): Promise<Array<{ principal_id: string; scopes: string[]; revoked: boolean }>> {
  return sql`
    SELECT principal_id, scopes, revoked_at IS NOT NULL AS revoked
      FROM harness_shared.personal_grants
     WHERE workspace_id = ${WS}
     ORDER BY principal_id, granted_at`;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'vaultmail1414' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE harness_shared.users (id uuid PRIMARY KEY, username text NOT NULL UNIQUE);
    INSERT INTO harness_shared.users (id, username) VALUES ('${OWNER}', 'owner');
  `);
  await sql.unsafe(personalVaultSql);
  // 1327 renamed the table and later migrations added source provenance; only
  // the columns 1357 and 1414 read are reproduced here.
  await sql.unsafe(`
    ALTER TABLE harness_shared.personal_documents RENAME TO documents;
    ALTER TABLE harness_shared.documents
      ADD COLUMN source_id uuid,
      ADD COLUMN provider_account_id text;
  `);
  await sql.unsafe(datatypeSql);

  // Legacy state, written before 1414.
  await insertDoc('gmail', `${ACCOUNT}gmail:${SOURCE}:m1`, 'm1');
  await insertDoc('gmail', 'gmail:m2', 'm2');
  await insertDoc('gmail', `${ACCOUNT}gmail:${SOURCE}:m3`, 'm3-legacy');
  await insertDoc('mail', `${ACCOUNT}mail:${SOURCE}:m3`, 'm3-current');
  await insertDoc('calendar', `${ACCOUNT}calendar:${SOURCE}:e1`, 'e1', 'event');

  await sql`
    INSERT INTO harness_shared.personal_grants
      (workspace_id, user_id, principal_type, principal_id, scopes, granted_by, granted_at, revoked_at)
    VALUES
      (${WS}, ${OWNER}::uuid, 'plan-template', 'meeting-prep', ${['personal:calendar', 'personal:gmail']}, 'owner', now() - interval '3 days', NULL),
      (${WS}, ${OWNER}::uuid, 'plan-template', 'follow-up', ${['personal:gmail']}, 'owner', now() - interval '3 days', NULL),
      (${WS}, ${OWNER}::uuid, 'plan-template', 'follow-up', ${['personal:mail']}, 'owner', now() - interval '2 days', NULL),
      (${WS}, ${OWNER}::uuid, 'binding', 'old-binding', ${['personal:gmail']}, 'owner', now() - interval '5 days', now() - interval '4 days')`;

  await sql`
    INSERT INTO harness_shared.personal_sync_state (workspace_id, user_id, source, cursor)
    VALUES (${WS}, ${OWNER}::uuid, 'gmail', '{"historyId":"7"}'::jsonb),
           (${WS}, ${OWNER}::uuid, 'contacts', '{}'::jsonb)`;

  const [identity] = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.personal_identities (workspace_id, user_id, display_name)
    VALUES (${WS}, ${OWNER}::uuid, 'Pat') RETURNING id`;
  await sql`
    INSERT INTO harness_shared.personal_identity_aliases
      (workspace_id, user_id, identity_id, source, alias_kind, normalized_value)
    VALUES
      (${WS}, ${OWNER}::uuid, ${identity!.id}::uuid, 'gmail', 'email', 'pat@example.com'),
      (${WS}, ${OWNER}::uuid, ${identity!.id}::uuid, 'gmail', 'email', 'twin@example.com'),
      (${WS}, ${OWNER}::uuid, ${identity!.id}::uuid, 'mail', 'email', 'twin@example.com')`;

  await sql.unsafe(mailPartitionSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

describe('1414 vault mail partition', () => {
  it('renames every gmail-partition document, its dedupe key and its generated scope', async () => {
    const rows = await docs();
    expect(rows.filter((r) => r.source === 'gmail')).toEqual([]);
    expect(rows.map((r) => [r.source, r.scope_key, r.dedupe_key, r.title])).toEqual([
      ['calendar', 'personal:calendar', `${ACCOUNT}calendar:${SOURCE}:e1`, 'e1'],
      ['mail', 'personal:mail', `${ACCOUNT}mail:${SOURCE}:m1`, 'm1'],
      ['mail', 'personal:mail', `${ACCOUNT}mail:${SOURCE}:m3`, 'm3-current'],
      // Bare archive-shaped key: 1357's insert trigger source-scoped it first.
      ['mail', 'personal:mail', `mail:${SOURCE}:m2`, 'm2'],
    ]);
  });

  it('rewrites grant scopes and leaves one live grant per converged scope set', async () => {
    expect(await grants()).toEqual([
      { principal_id: 'follow-up', scopes: ['personal:mail'], revoked: true },
      { principal_id: 'follow-up', scopes: ['personal:mail'], revoked: false },
      { principal_id: 'meeting-prep', scopes: ['personal:calendar', 'personal:mail'], revoked: false },
      { principal_id: 'old-binding', scopes: ['personal:mail'], revoked: true },
    ]);
    const [revoked] = await sql<Array<{ by: string }>>`
      SELECT metadata->>'revokedBy' AS by FROM harness_shared.personal_grants
       WHERE workspace_id = ${WS} AND principal_id = 'follow-up' AND revoked_at IS NOT NULL`;
    expect(revoked!.by).toBe('1414-vault-mail-partition');
  });

  it('moves sync state and identity aliases, keeping a mail twin over its legacy row', async () => {
    const state = await sql<Array<{ source: string; cursor: unknown }>>`
      SELECT source, cursor FROM harness_shared.personal_sync_state WHERE workspace_id = ${WS} ORDER BY source`;
    expect(state).toEqual([
      { source: 'contacts', cursor: {} },
      { source: 'mail', cursor: { historyId: '7' } },
    ]);
    const aliases = await sql<Array<{ source: string; normalized_value: string }>>`
      SELECT source, normalized_value FROM harness_shared.personal_identity_aliases
       WHERE workspace_id = ${WS} ORDER BY normalized_value`;
    expect(aliases).toEqual([
      { source: 'mail', normalized_value: 'pat@example.com' },
      { source: 'mail', normalized_value: 'twin@example.com' },
    ]);
  });

  it('lands a legacy-shaped upsert in the renamed partition instead of minting a twin', async () => {
    // The pre-D-010 release writes the bare `gmail:<native>` key with no
    // datatype; 1357 source-scopes it, 1414 moves it into `mail`.
    await sql`
      INSERT INTO harness_shared.documents
        (workspace_id, user_id, source, kind, external_id, title, dedupe_key, source_id)
      VALUES (${WS}, ${OWNER}::uuid, 'gmail', 'message', 'm1', 'm1-resynced', ${`${ACCOUNT}gmail:m1`}, ${SOURCE}::uuid)
      ON CONFLICT (workspace_id, user_id, source, dedupe_key)
      DO UPDATE SET title = EXCLUDED.title`;
    const rows = await docs();
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.dedupe_key === `${ACCOUNT}mail:${SOURCE}:m1`)).toMatchObject({
      source: 'mail', scope_key: 'personal:mail', title: 'm1-resynced', datatype_id: 'email-message',
    });

    await sql`
      INSERT INTO harness_shared.personal_grants
        (workspace_id, user_id, principal_type, principal_id, scopes, granted_by)
      VALUES (${WS}, ${OWNER}::uuid, 'agent-role', 'mail-assistant', ${['personal:gmail', 'personal:contacts']}, 'owner')`;
    const [granted] = await sql<Array<{ scopes: string[] }>>`
      SELECT scopes FROM harness_shared.personal_grants WHERE workspace_id = ${WS} AND principal_id = 'mail-assistant'`;
    expect(granted!.scopes).toEqual(['personal:contacts', 'personal:mail']);

    await sql`
      INSERT INTO harness_shared.personal_sync_state (workspace_id, user_id, source, cursor)
      VALUES (${WS}, ${OWNER}::uuid, 'gmail', '{"historyId":"8"}'::jsonb)
      ON CONFLICT (workspace_id, user_id, source) DO UPDATE SET cursor = EXCLUDED.cursor`;
    const [cursor] = await sql<Array<{ cursor: unknown }>>`
      SELECT cursor FROM harness_shared.personal_sync_state WHERE workspace_id = ${WS} AND source = 'mail'`;
    expect(cursor!.cursor).toEqual({ historyId: '8' });
  });

  it('is a no-op when applied again', async () => {
    const before = { docs: await docs(), grants: await grants() };
    await sql.unsafe(mailPartitionSql);
    expect(await docs()).toEqual(before.docs);
    expect(await grants()).toEqual(before.grants);
  });
});
