/** Real-PostgreSQL data-integrity guard for migration 1154. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const armed = join(HERE, '..', 'sql', '1154-prose-embedding-profile-identity.sql');
const path = existsSync(armed) ? armed : `${armed}.DRAFT`;
const migrationSql = readFileSync(path, 'utf8');
const migrationChunks = migrationSql
  .split(/-->\s*statement-breakpoint/g)
  .map((chunk) => chunk.trim())
  .filter((chunk) => chunk.length > 0 && !/^(\s*--[^\n]*\n?)+$/.test(chunk));

let db: MigratedTestDb;
let sql: Sql;

async function applyMigration(): Promise<void> {
  for (const chunk of migrationChunks) await sql.unsafe(chunk);
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'prose-profile-1154' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector; CREATE SCHEMA harness_shared');
  await sql.unsafe(`
    CREATE TABLE harness_shared.work_items (
      feature_id text PRIMARY KEY,
      embedding vector(3),
      embedding_mode text
    );
    CREATE VIEW harness_shared.harness_features_consolidated AS
      SELECT feature_id, embedding, embedding_mode FROM harness_shared.work_items;
    CREATE VIEW harness_shared.harness_features AS
      SELECT feature_id, embedding, embedding_mode FROM harness_shared.harness_features_consolidated;
    CREATE VIEW harness_shared.work_items_claimable AS
      SELECT feature_id, embedding, embedding_mode FROM harness_shared.work_items;
    CREATE VIEW harness_shared.engineer_issues AS
      SELECT feature_id AS issue_id, embedding, embedding_mode FROM harness_shared.work_items;
    CREATE TABLE harness_shared.code_recipes (
      id text PRIMARY KEY,
      embedding vector(3)
    );
    CREATE TABLE harness_shared.datatype_registry (
      id text PRIMARY KEY,
      embedding vector(3)
    );
    INSERT INTO harness_shared.work_items (feature_id, embedding, embedding_mode) VALUES
      ('current-gemma', '[1,0,0]', 'gemma'),
      ('current-openai', '[0,1,0]', 'openai'),
      ('unknown-mode', '[0,0,1]', 'future'),
      ('mode-less', '[1,1,0]', NULL),
      ('empty', NULL, 'gemma');
    INSERT INTO harness_shared.code_recipes (id, embedding)
      VALUES ('mode-less-recipe', '[1,0,0]');
    INSERT INTO harness_shared.datatype_registry (id, embedding)
      VALUES ('mode-less-datatype', '[0,1,0]');
  `);
  await applyMigration();
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1154 — exact shared prose profile identity', () => {
  it('bounds unrelated ACCESS EXCLUSIVE locks to singleton runner transactions', () => {
    expect(migrationChunks).toHaveLength(17);
    for (const chunk of migrationChunks.slice(0, -1)) {
      const targets = [...chunk.matchAll(/ALTER TABLE IF EXISTS\s+([\w.]+)/gi)].map((match) => match[1]);
      expect(targets, chunk).toHaveLength(1);
      expect(chunk).not.toMatch(/LOCK TABLE/i);
      expect(targets[0]).not.toBe('harness_shared.work_items');
    }
    const finalChunk = migrationChunks.at(-1)!;
    expect(finalChunk).toContain('LOCK TABLE harness_shared.harness_features IN ACCESS EXCLUSIVE MODE');
    expect(finalChunk).toContain('LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE');
    expect(finalChunk).toContain('ALTER TABLE IF EXISTS harness_shared.work_items');
    expect(finalChunk).not.toContain('harness_shared.session_turns');
  });

  it('preserves legacy vector bytes without rewriting inferred profile metadata', async () => {
    const rows = await sql<Array<{
      feature_id: string;
      embedding: string | null;
      embedding_profile: string | null;
    }>>`
      SELECT feature_id, embedding::text, embedding_profile
        FROM harness_shared.work_items
       ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: 'current-gemma', embedding: '[1,0,0]', embedding_profile: null },
      { feature_id: 'current-openai', embedding: '[0,1,0]', embedding_profile: null },
      { feature_id: 'empty', embedding: null, embedding_profile: null },
      { feature_id: 'mode-less', embedding: '[1,1,0]', embedding_profile: null },
      { feature_id: 'unknown-mode', embedding: '[0,0,1]', embedding_profile: null },
    ]);
  });

  it('does not build profile indexes while holding the expand transaction locks', async () => {
    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = 'harness_shared'
         AND indexname LIKE '%\\_profile\\_idx' ESCAPE '\\'
       ORDER BY indexname`;
    expect(indexes).toEqual([]);
  });

  it('adds mode and profile columns to older mode-less surfaces without guessing identity', async () => {
    const [recipe] = await sql<Array<{
      embedding: string;
      embedding_mode: string | null;
      embedding_profile: string | null;
    }>>`
      SELECT embedding::text, embedding_mode, embedding_profile
        FROM harness_shared.code_recipes
       WHERE id = 'mode-less-recipe'`;
    const [datatype] = await sql<Array<{
      embedding: string;
      embedding_mode: string | null;
      embedding_profile: string | null;
    }>>`
      SELECT embedding::text, embedding_mode, embedding_profile
        FROM harness_shared.datatype_registry
       WHERE id = 'mode-less-datatype'`;
    expect(recipe).toEqual({ embedding: '[1,0,0]', embedding_mode: null, embedding_profile: null });
    expect(datatype).toEqual({ embedding: '[0,1,0]', embedding_mode: null, embedding_profile: null });
  });

  it('projects the appended exact identity through every compatibility view', async () => {
    for (const view of [
      'harness_features_consolidated',
      'harness_features',
      'work_items_claimable',
      'engineer_issues',
    ]) {
      const [column] = await sql<{ present: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'harness_shared'
             AND table_name = ${view}
             AND column_name = 'embedding_profile'
        ) AS present`;
      expect(column.present, view).toBe(true);
    }
  });

  it('is idempotent and never overwrites an explicit exact identity', async () => {
    await sql`
      UPDATE harness_shared.work_items
         SET embedding_profile = 'foreign-space@v2'
       WHERE feature_id = 'current-gemma'`;
    await expect(applyMigration()).resolves.toBeUndefined();
    const [row] = await sql<{ embedding_profile: string }[]>`
      SELECT embedding_profile FROM harness_shared.work_items
       WHERE feature_id = 'current-gemma'`;
    expect(row.embedding_profile).toBe('foreign-space@v2');
  });
});
