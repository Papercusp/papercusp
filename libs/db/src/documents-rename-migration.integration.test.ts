/**
 * Migration 1327 — rename harness_shared.personal_documents to documents (EXPAND step).
 *
 * Plan enterprise-data-sources-2026-10-01, P-014 follow-up; WI-10005071.
 *
 * Applies the REAL corpus chain (874 → 980 → 1316) over seeded rows, then 1327, and pins
 * what the expand step promises:
 *   - the base table is now `documents`, and no index, constraint or policy on it still
 *     carries the personal_documents prefix;
 *   - rows written before the rename survive and read through both names;
 *   - the deployed release, which still says `personal_documents`, keeps working through
 *     the compat view: its three upsert shapes (personal-vault/store.ts with DO UPDATE
 *     columns qualified by the view name, the organization partial-index arbiter in
 *     documents-corpus.ts, the pot partial-index arbiter in chat-retrieval-units.ts),
 *     plus UPDATE and DELETE;
 *   - the view is security_invoker and carries the table's grants.
 */
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

const CHAIN = [
  '874-personal-vault.sql',
  '980-personal-vault-account-provenance.sql',
  '1316-documents-corpus-scope-permissions.sql',
];
const rename1327 = readFileSync(migrationPath('1327-rename-personal-documents-to-documents.sql'), 'utf8');

const OWNER = '11111111-1111-4111-8111-111111111111';
const LIST = '33333333-3333-4333-8333-333333333333';

let db: MigratedTestDb;
let sql: Sql;
let seededId: string;

/** The deployed release's personal-vault upsert (store.ts), verbatim in shape. */
async function legacyPersonalUpsert(title: string): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.personal_documents
      (workspace_id, user_id, source, kind, title, text, metadata, dedupe_key)
    VALUES ('ws-a', ${OWNER}::uuid, 'gmail', 'message', ${title}, 'body', '{}'::jsonb, 'gmail:legacy-upsert')
    ON CONFLICT (workspace_id, user_id, source, dedupe_key) DO UPDATE
      SET title = EXCLUDED.title,
          embedding_mode = CASE
            WHEN personal_documents.title IS DISTINCT FROM EXCLUDED.title
              OR personal_documents.text IS DISTINCT FROM EXCLUDED.text
            THEN NULL ELSE personal_documents.embedding_mode END,
          updated_at = now()
    RETURNING id::text`;
  return row!.id;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'documents1327' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    DO $pg$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin; END IF;
    END $pg$;
    CREATE SCHEMA harness_shared;
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE harness_shared.users (id uuid PRIMARY KEY, username text NOT NULL UNIQUE);
    INSERT INTO harness_shared.users (id, username) VALUES ('${OWNER}', 'owner');
    CREATE TABLE harness_shared.trigger_sources (
      workspace_id text NOT NULL,
      id uuid NOT NULL,
      kind text NOT NULL,
      owner_user_id uuid,
      provider_account_id text,
      PRIMARY KEY (workspace_id, id)
    );
  `);
  for (const file of CHAIN) {
    await sql.unsafe(readFileSync(migrationPath(file), 'utf8'));
    if (file.startsWith('874-')) {
      const [row] = await sql<Array<{ id: string }>>`
        INSERT INTO harness_shared.personal_documents (workspace_id, user_id, source, kind, title, dedupe_key)
        VALUES ('ws-a', ${OWNER}::uuid, 'gmail', 'message', 'before-rename', 'gmail:seed')
        RETURNING id::text`;
      seededId = row!.id;
    }
  }
  await sql`
    INSERT INTO harness_shared.document_permission_lists (workspace_id, id, source, source_ref)
    VALUES ('ws-a', ${LIST}::uuid, 'slack', 'C1')`;
  await sql.unsafe(rename1327);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1327 — personal_documents renamed to documents', () => {
  it('makes documents the base table and personal_documents a security_invoker view', async () => {
    const rows = await sql<Array<{ relname: string; relkind: string; reloptions: string[] | null }>>`
      SELECT c.relname, c.relkind::text, c.reloptions
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'harness_shared' AND c.relname IN ('documents', 'personal_documents')
       ORDER BY c.relname`;
    expect(rows.map((r) => [r.relname, r.relkind])).toEqual([
      ['documents', 'r'],
      ['personal_documents', 'v'],
    ]);
    expect(rows[1]!.reloptions).toContain('security_invoker=true');
  });

  it('leaves no index, constraint or policy named with the old prefix', async () => {
    const names = await sql<Array<{ name: string }>>`
      SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'harness_shared.documents'::regclass
      UNION ALL
      SELECT conname FROM pg_constraint WHERE conrelid = 'harness_shared.documents'::regclass
      UNION ALL
      SELECT polname FROM pg_policy WHERE polrelid = 'harness_shared.documents'::regclass`;
    const all = names.map((r) => r.name);
    // Positive control: the catalog query sees the renamed objects at all.
    expect(all).toEqual(expect.arrayContaining([
      'documents_pkey',
      'documents_workspace_id_user_id_source_dedupe_key_key',
      'documents_organization_dedupe',
      'documents_pot_dedupe',
      'documents_scope_chk',
      'documents_embedding_mode_check',
      'documents_workspace_isolation',
    ]));
    expect(all.filter((n) => n.startsWith('personal_documents'))).toEqual([]);
  });

  it('keeps rows written before the rename, readable through both names', async () => {
    const [viaTable] = await sql`SELECT title FROM harness_shared.documents WHERE id = ${seededId}::uuid`;
    const [viaView] = await sql`SELECT title FROM harness_shared.personal_documents WHERE id = ${seededId}::uuid`;
    expect(viaTable?.title).toBe('before-rename');
    expect(viaView?.title).toBe('before-rename');
  });

  it('accepts the deployed personal-vault upsert through the view, arbiter and DO UPDATE included', async () => {
    const first = await legacyPersonalUpsert('first');
    const second = await legacyPersonalUpsert('second');
    expect(second).toBe(first);
    const [row] = await sql`
      SELECT title, scope, scope_key, text_tsv IS NOT NULL AS has_tsv
        FROM harness_shared.documents WHERE id = ${first}::uuid`;
    expect(row).toMatchObject({ title: 'second', scope: 'personal', has_tsv: true });
    expect(row?.scope_key).toBeTruthy();
  });

  it('accepts the organization and pot partial-index upserts through the view', async () => {
    for (let i = 0; i < 2; i += 1) {
      await sql`
        INSERT INTO harness_shared.personal_documents
          (workspace_id, user_id, scope, permission_list_id, source, kind, title, text, metadata, dedupe_key)
        VALUES ('ws-a', NULL, 'organization', ${LIST}::uuid, 'slack', 'message', ${`org-${i}`}, '', '{}'::jsonb, 'slack:org-1')
        ON CONFLICT (workspace_id, source, dedupe_key) WHERE scope = 'organization'
        DO UPDATE SET title = EXCLUDED.title, updated_at = now()`;
      await sql`
        INSERT INTO harness_shared.personal_documents
          (workspace_id, user_id, scope, pot_slug, source, kind, title, text, metadata, dedupe_key)
        VALUES ('ws-a', NULL, 'pot', 'pot-a', 'slack', 'message', ${`pot-${i}`}, '', '{}'::jsonb, 'slack:pot-1')
        ON CONFLICT (workspace_id, pot_slug, source, dedupe_key) WHERE scope = 'pot'
        DO UPDATE SET title = EXCLUDED.title, updated_at = now()`;
    }
    const rows = await sql<Array<{ scope: string; title: string }>>`
      SELECT scope, title FROM harness_shared.documents
       WHERE dedupe_key IN ('slack:org-1', 'slack:pot-1') ORDER BY scope`;
    expect(rows).toEqual([
      { scope: 'organization', title: 'org-1' },
      { scope: 'pot', title: 'pot-1' },
    ]);
  });

  it('passes UPDATE and DELETE through the view to the base table', async () => {
    await sql`UPDATE harness_shared.personal_documents SET title = 'updated' WHERE id = ${seededId}::uuid`;
    const [row] = await sql`SELECT title FROM harness_shared.documents WHERE id = ${seededId}::uuid`;
    expect(row?.title).toBe('updated');
    await sql`DELETE FROM harness_shared.personal_documents WHERE id = ${seededId}::uuid`;
    const gone = await sql`SELECT 1 FROM harness_shared.documents WHERE id = ${seededId}::uuid`;
    expect(gone).toHaveLength(0);
  });

  it('grants the view exactly the privileges the table grants', async () => {
    const grants = await sql<Array<{ table_name: string; grantee: string; privs: string }>>`
      SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
        FROM information_schema.role_table_grants
       WHERE table_schema = 'harness_shared'
         AND table_name IN ('documents', 'personal_documents')
         AND grantee IN ('harness_app', 'harness_admin')
       GROUP BY table_name, grantee`;
    const of = (table: string) =>
      Object.fromEntries(grants.filter((g) => g.table_name === table).map((g) => [g.grantee, g.privs]));
    expect(Object.keys(of('documents')).length).toBeGreaterThan(0);
    expect(of('personal_documents')).toEqual(of('documents'));
  });
});
