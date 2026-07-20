/**
 * memory-canonical-promote-scope.integration.test.ts — migration 398 promotes the
 * memory scope keys (user_id, workspace_id) from payload jsonb to GENERATED STORED
 * columns (data-scoping-audit-2026-06-22 P-006 / D-004; D-006 fresh-DB discipline).
 *
 * Focused provision: build memory_canonical (the migration-081 shape) on a fresh DB,
 * seed rows that PRE-DATE the migration, then apply 398's SQL verbatim and assert the
 * promotion + auto-backfill + payload-lockstep + indexes. 398 only depends on
 * memory_canonical existing, so a full 275-migration apply isn't needed to exercise it.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts \
 *     src/memory-canonical-promote-scope.integration.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, '..', 'sql');
const MIGRATION_398 = readFileSync(
  join(SQL_DIR, '398-memory-canonical-promote-scope-columns.sql'),
  'utf8',
);

// The migration-081 memory_canonical shape that 398 alters (pgcrypto → gen_random_uuid).
const BASE_DDL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE IF NOT EXISTS harness_shared.memory_canonical (
    id          uuid        NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
    payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
`;

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BASE_DDL);
    // Seed rows BEFORE the migration → proves the generated columns auto-backfill
    // existing rows at ADD time (the D-006 backfill, for free).
    await client.unsafe(`
      INSERT INTO harness_shared.memory_canonical (payload) VALUES
        ('{"user_id":"user-A","workspace_id":"ws-1","data":"pre-existing scoped"}'::jsonb),
        ('{"user_id":"user-B","data":"pre-existing, owner-global / pre-fix (no workspace)"}'::jsonb)
    `);
    await client.unsafe(MIGRATION_398);
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'memscope', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 398: memory_canonical scope-column promotion', () => {
  it('promotes user_id + workspace_id to GENERATED real columns', async () => {
    const cols = (await sql`
      SELECT column_name, is_generated
      FROM information_schema.columns
      WHERE table_schema = 'harness_shared' AND table_name = 'memory_canonical'
        AND column_name IN ('user_id', 'workspace_id')
      ORDER BY column_name`) as unknown as Array<{ column_name: string; is_generated: string }>;
    expect(cols.map((c) => c.column_name)).toEqual(['user_id', 'workspace_id']);
    expect(cols.every((c) => c.is_generated === 'ALWAYS')).toBe(true);
  });

  it('auto-backfills the columns for rows that pre-date the migration', async () => {
    const rows = (await sql`
      SELECT user_id, workspace_id FROM harness_shared.memory_canonical
      ORDER BY payload->>'user_id'`) as unknown as Array<{ user_id: string | null; workspace_id: string | null }>;
    expect(rows).toEqual([
      { user_id: 'user-A', workspace_id: 'ws-1' },
      { user_id: 'user-B', workspace_id: null }, // no payload.workspace_id → NULL, never a 'default' bucket
    ]);
  });

  it('stays in lockstep with payload on new writes (generated, never inserted)', async () => {
    await sql`INSERT INTO harness_shared.memory_canonical (payload)
              VALUES ('{"user_id":"user-C","workspace_id":"ws-2"}'::jsonb)`;
    const [row] = (await sql`
      SELECT user_id, workspace_id FROM harness_shared.memory_canonical
      WHERE payload->>'user_id' = 'user-C'`) as unknown as Array<{ user_id: string; workspace_id: string }>;
    expect(row).toEqual({ user_id: 'user-C', workspace_id: 'ws-2' });
  });

  it('reflects a later payload UPDATE in the generated column', async () => {
    await sql`UPDATE harness_shared.memory_canonical
              SET payload = payload || '{"workspace_id":"ws-moved"}'::jsonb
              WHERE payload->>'user_id' = 'user-B'`;
    const [row] = (await sql`
      SELECT workspace_id FROM harness_shared.memory_canonical
      WHERE payload->>'user_id' = 'user-B'`) as unknown as Array<{ workspace_id: string }>;
    expect(row.workspace_id).toBe('ws-moved');
  });

  it('rejects a direct write to a generated column (payload is the only source of truth)', async () => {
    await expect(
      sql`INSERT INTO harness_shared.memory_canonical (payload, workspace_id)
          VALUES ('{}'::jsonb, 'ws-illegal')`,
    ).rejects.toThrow();
  });

  it('creates the scope indexes', async () => {
    const idx = (await sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'harness_shared' AND tablename = 'memory_canonical'
        AND indexname IN (
          'memory_canonical_user_id_col_idx',
          'memory_canonical_workspace_id_idx',
          'memory_canonical_ws_user_idx')
      ORDER BY indexname`) as unknown as Array<{ indexname: string }>;
    expect(idx.map((r) => r.indexname)).toEqual([
      'memory_canonical_user_id_col_idx',
      'memory_canonical_workspace_id_idx',
      'memory_canonical_ws_user_idx',
    ]);
  });

  it('is idempotent — re-applying 398 is a clean no-op', async () => {
    await expect(sql.unsafe(MIGRATION_398)).resolves.toBeDefined();
  });
});
