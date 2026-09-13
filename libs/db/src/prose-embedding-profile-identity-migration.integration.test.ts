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

let db: MigratedTestDb;
let sql: Sql;

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
    INSERT INTO harness_shared.work_items (feature_id, embedding, embedding_mode) VALUES
      ('current-gemma', '[1,0,0]', 'gemma'),
      ('current-openai', '[0,1,0]', 'openai'),
      ('unknown-mode', '[0,0,1]', 'future'),
      ('mode-less', '[1,1,0]', NULL),
      ('empty', NULL, 'gemma');
  `);
  await sql.unsafe(migrationSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1154 — exact shared prose profile identity', () => {
  it('maps only known legacy current modes without touching vector bytes', async () => {
    const rows = await sql<Array<{
      feature_id: string;
      embedding: string | null;
      embedding_profile: string | null;
    }>>`
      SELECT feature_id, embedding::text, embedding_profile
        FROM harness_shared.work_items
       ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: 'current-gemma', embedding: '[1,0,0]', embedding_profile: 'gemma-embeddinggemma-300m-768@v1' },
      { feature_id: 'current-openai', embedding: '[0,1,0]', embedding_profile: 'openai-text-embedding-3-small-768@v1' },
      { feature_id: 'empty', embedding: null, embedding_profile: null },
      { feature_id: 'mode-less', embedding: '[1,1,0]', embedding_profile: null },
      { feature_id: 'unknown-mode', embedding: '[0,0,1]', embedding_profile: null },
    ]);
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
    await expect(sql.unsafe(migrationSql)).resolves.toBeDefined();
    const [row] = await sql<{ embedding_profile: string }[]>`
      SELECT embedding_profile FROM harness_shared.work_items
       WHERE feature_id = 'current-gemma'`;
    expect(row.embedding_profile).toBe('foreign-space@v2');
  });
});

