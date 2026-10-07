/**
 * Migration 1416 — CONTRACT for the Personal Vault expand windows opened by
 * 1357 (datatype routing) and 1414 (gmail -> mail partition); WI-10006996.
 *
 * Applies the real 874 + 1357 + 1414 + 1416 SQL and proves:
 *   - positive control: before 1416 all five transitional triggers exist and a
 *     legacy-shaped write IS rewritten (so "gone" below cannot pass vacuously);
 *   - after 1416 no transitional trigger or function remains;
 *   - a legacy-shaped write is stored exactly as written (no silent repair);
 *   - a current-shape write is unaffected;
 *   - re-applying 1416 is a no-op.
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
const contractSql = readFileSync(migrationPath('1416-drop-vault-transitional-normalizers.sql'), 'utf8');

const OWNER = '11111111-1111-4111-8111-111111111111';
const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS = 'ws-contract';
const ACCOUNT = `account:${createHash('sha256').update('owner@example.com').digest('hex')}:`;

const TRANSITIONAL_TRIGGERS = [
  'documents_normalize_legacy_routing',
  'documents_normalize_mail_partition',
  'personal_grants_normalize_mail_partition',
  'personal_identity_aliases_normalize_mail_partition',
  'personal_sync_state_normalize_mail_partition',
];
const TRANSITIONAL_FUNCTIONS = [
  'documents_normalize_legacy_routing',
  'documents_normalize_mail_partition',
  'personal_grants_normalize_mail_partition',
  'personal_mail_partition_scopes',
  'personal_source_normalize_mail_partition',
];

let db: MigratedTestDb;
let sql: Sql;
let triggersBefore: string[] = [];
let functionsBefore: string[] = [];
let legacyBefore: { source: string; dedupe_key: string; datatype_id: string | null } | undefined;

async function transitionalTriggers(): Promise<string[]> {
  const rows = await sql<Array<{ tgname: string }>>`
    SELECT t.tgname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared' AND NOT t.tgisinternal
       AND t.tgname = ANY(${TRANSITIONAL_TRIGGERS})
     ORDER BY t.tgname`;
  return rows.map((r) => r.tgname);
}

async function transitionalFunctions(): Promise<string[]> {
  const rows = await sql<Array<{ proname: string }>>`
    SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'harness_shared' AND p.proname = ANY(${TRANSITIONAL_FUNCTIONS})
     ORDER BY p.proname`;
  return rows.map((r) => r.proname);
}

async function insertLegacyDoc(externalId: string): Promise<void> {
  // The shape a pre-D-010, pre-1414 release writes: source 'gmail', no
  // datatype, the bare (not source-scoped) dedupe key.
  await sql`
    INSERT INTO harness_shared.documents
      (workspace_id, user_id, source, kind, external_id, title, dedupe_key, source_id)
    VALUES (${WS}, ${OWNER}::uuid, 'gmail', 'message', ${externalId}, ${externalId},
            ${`${ACCOUNT}gmail:${externalId}`}, ${SOURCE}::uuid)`;
}

async function doc(externalId: string): Promise<{ source: string; dedupe_key: string; datatype_id: string | null } | undefined> {
  const [row] = await sql<Array<{ source: string; dedupe_key: string; datatype_id: string | null }>>`
    SELECT source, dedupe_key, datatype_id
      FROM harness_shared.documents
     WHERE workspace_id = ${WS} AND external_id = ${externalId}`;
  return row;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'vaultcontract1416' });
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
  // the columns 1357, 1414 and this test read are reproduced here.
  await sql.unsafe(`
    ALTER TABLE harness_shared.personal_documents RENAME TO documents;
    ALTER TABLE harness_shared.documents
      ADD COLUMN source_id uuid,
      ADD COLUMN provider_account_id text;
  `);
  await sql.unsafe(datatypeSql);
  await sql.unsafe(mailPartitionSql);

  // Positive control, captured BEFORE the contract migration runs.
  triggersBefore = await transitionalTriggers();
  functionsBefore = await transitionalFunctions();
  await insertLegacyDoc('before-contract');
  legacyBefore = await doc('before-contract');

  await sql.unsafe(contractSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

describe('1416 drop vault transitional normalizers', () => {
  it('positive control: before 1416 every transitional trigger exists and rewrites a legacy write', () => {
    expect(triggersBefore).toEqual(TRANSITIONAL_TRIGGERS);
    expect(functionsBefore).toEqual(TRANSITIONAL_FUNCTIONS);
    expect(legacyBefore).toEqual({
      source: 'mail',
      dedupe_key: `${ACCOUNT}mail:${SOURCE}:before-contract`,
      datatype_id: 'email-message',
    });
  });

  it('leaves no transitional trigger or function behind', async () => {
    expect(await transitionalTriggers()).toEqual([]);
    expect(await transitionalFunctions()).toEqual([]);
  });

  it('stores a legacy-shaped write exactly as written instead of silently repairing it', async () => {
    await insertLegacyDoc('after-contract');
    expect(await doc('after-contract')).toEqual({
      source: 'gmail',
      dedupe_key: `${ACCOUNT}gmail:after-contract`,
      datatype_id: null,
    });

    await sql`
      INSERT INTO harness_shared.personal_grants
        (workspace_id, user_id, principal_type, principal_id, scopes, granted_by)
      VALUES (${WS}, ${OWNER}::uuid, 'agent-role', 'legacy-role', ${['personal:gmail']}, 'owner')`;
    const [grant] = await sql<Array<{ scopes: string[] }>>`
      SELECT scopes FROM harness_shared.personal_grants WHERE workspace_id = ${WS} AND principal_id = 'legacy-role'`;
    expect(grant!.scopes).toEqual(['personal:gmail']);

    await sql`
      INSERT INTO harness_shared.personal_sync_state (workspace_id, user_id, source, cursor)
      VALUES (${WS}, ${OWNER}::uuid, 'gmail', '{"historyId":"9"}'::jsonb)`;
    const [state] = await sql<Array<{ source: string }>>`
      SELECT source FROM harness_shared.personal_sync_state
       WHERE workspace_id = ${WS} AND cursor = '{"historyId":"9"}'::jsonb`;
    expect(state!.source).toBe('gmail');
  });

  it('stores a current-shape write unchanged', async () => {
    await sql`
      INSERT INTO harness_shared.documents
        (workspace_id, user_id, source, kind, external_id, title, dedupe_key, source_id, datatype_id)
      VALUES (${WS}, ${OWNER}::uuid, 'mail', 'message', 'current', 'current',
              ${`${ACCOUNT}mail:${SOURCE}:current`}, ${SOURCE}::uuid, 'email-message')`;
    expect(await doc('current')).toEqual({
      source: 'mail',
      dedupe_key: `${ACCOUNT}mail:${SOURCE}:current`,
      datatype_id: 'email-message',
    });
  });

  it('is a no-op when applied again', async () => {
    await sql.unsafe(contractSql);
    expect(await transitionalTriggers()).toEqual([]);
    expect(await transitionalFunctions()).toEqual([]);
  });
});
