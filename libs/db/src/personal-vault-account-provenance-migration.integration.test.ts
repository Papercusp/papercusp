/**
 * Migration 980 — account-scoped Personal Vault provenance.
 *
 * Applies the real migration over legacy Personal Vault rows and proves that
 * backfill is conservative, identity-preserving, account-namespaced, and
 * idempotent across workspace and user boundaries.
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
const provenanceSql = readFileSync(migrationPath('980-personal-vault-account-provenance.sql'), 'utf8');

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';
const GMAIL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const GMAIL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const GMAIL_OTHER_WORKSPACE = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const GCAL_A = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const GCAL_B = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';

let db: MigratedTestDb;
let sql: Sql;
let seededDocumentIds: string[];

function accountDedupe(account: string, raw: string): string {
  return `account:${createHash('sha256').update(account).digest('hex')}:${raw}`;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'personal980' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE harness_shared.users (
      id uuid PRIMARY KEY,
      username text NOT NULL UNIQUE
    );
    INSERT INTO harness_shared.users (id, username)
    VALUES
      ('${OWNER_A}', 'owner-a'),
      ('${OWNER_B}', 'owner-b');
  `);
  await sql.unsafe(personalVaultSql);
  await sql.unsafe(`
    CREATE TABLE harness_shared.trigger_sources (
      workspace_id text NOT NULL,
      id uuid NOT NULL,
      kind text NOT NULL,
      owner_user_id uuid,
      provider_account_id text,
      PRIMARY KEY (workspace_id, id)
    );
  `);
  await sql`
    INSERT INTO harness_shared.trigger_sources
      (workspace_id, id, kind, owner_user_id, provider_account_id)
    VALUES
      ('ws-a', ${GMAIL_A}::uuid, 'gmail', ${OWNER_A}::uuid, 'a@example.com'),
      ('ws-a', ${GMAIL_B}::uuid, 'gmail', ${OWNER_B}::uuid, 'b@example.com'),
      ('ws-b', ${GMAIL_OTHER_WORKSPACE}::uuid, 'gmail', ${OWNER_A}::uuid, 'other@example.com'),
      ('ws-a', ${GCAL_A}::uuid, 'gcal', ${OWNER_A}::uuid, 'a@example.com'),
      ('ws-a', ${GCAL_B}::uuid, 'gcal', ${OWNER_A}::uuid, 'second@example.com')`;
  const documents = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.personal_documents
      (workspace_id, user_id, source, kind, title, dedupe_key)
    VALUES
      ('ws-a', ${OWNER_A}::uuid, 'gmail', 'message', 'owner-a-gmail', 'gmail:shared'),
      ('ws-a', ${OWNER_B}::uuid, 'gmail', 'message', 'owner-b-gmail', 'gmail:shared'),
      ('ws-b', ${OWNER_A}::uuid, 'gmail', 'message', 'other-workspace', 'gmail:shared'),
      ('ws-a', ${OWNER_A}::uuid, 'calendar', 'event', 'ambiguous-calendar', 'calendar:event-1')
    RETURNING id::text`;
  seededDocumentIds = documents.map((row) => row.id).sort();
  await sql.unsafe(provenanceSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 980 — Personal Vault account provenance', () => {
  it('backfills only the unambiguous source for the same workspace and owner', async () => {
    const rows = await sql<
      Array<{
        title: string;
        source_id: string | null;
        provider_account_id: string | null;
        dedupe_key: string;
      }>
    >`
      SELECT title, source_id::text, provider_account_id, dedupe_key
        FROM harness_shared.personal_documents
       ORDER BY title`;

    expect(rows).toEqual([
      {
        title: 'ambiguous-calendar',
        source_id: null,
        provider_account_id: null,
        dedupe_key: 'calendar:event-1',
      },
      {
        title: 'other-workspace',
        source_id: GMAIL_OTHER_WORKSPACE,
        provider_account_id: 'other@example.com',
        dedupe_key: accountDedupe('other@example.com', 'gmail:shared'),
      },
      {
        title: 'owner-a-gmail',
        source_id: GMAIL_A,
        provider_account_id: 'a@example.com',
        dedupe_key: accountDedupe('a@example.com', 'gmail:shared'),
      },
      {
        title: 'owner-b-gmail',
        source_id: GMAIL_B,
        provider_account_id: 'b@example.com',
        dedupe_key: accountDedupe('b@example.com', 'gmail:shared'),
      },
    ]);
  });

  it('preserves every legacy row identity and rejects blank account attribution', async () => {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id::text
        FROM harness_shared.personal_documents
       ORDER BY id`;
    expect(rows.map((row) => row.id)).toEqual(seededDocumentIds);

    await expect(sql`
      UPDATE harness_shared.personal_documents
         SET provider_account_id = ' '
       WHERE title = 'ambiguous-calendar'`).rejects.toThrow(/personal_documents_provider_account_nonempty/);
  });

  it('is idempotent without double-prefixing dedupe keys and installs both lookup indexes', async () => {
    const before = await sql<Array<{ title: string; dedupe_key: string }>>`
      SELECT title, dedupe_key
        FROM harness_shared.personal_documents
       ORDER BY title`;
    await sql.unsafe(provenanceSql);
    const after = await sql<Array<{ title: string; dedupe_key: string }>>`
      SELECT title, dedupe_key
        FROM harness_shared.personal_documents
       ORDER BY title`;
    expect(after).toEqual(before);

    const indexes = await sql<Array<{ indexname: string }>>`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = 'harness_shared'
         AND tablename = 'personal_documents'
         AND indexname IN (
           'personal_documents_account_time_idx',
           'personal_documents_source_id_idx'
         )
       ORDER BY indexname`;
    expect(indexes).toEqual([
      { indexname: 'personal_documents_account_time_idx' },
      { indexname: 'personal_documents_source_id_idx' },
    ]);
  });
});
