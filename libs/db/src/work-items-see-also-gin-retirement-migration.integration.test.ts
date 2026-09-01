/**
 * Migration 1082 — retire only the no-consumer work_items see_also GIN index.
 *
 * The false-direction control matters more than the one-line DROP: the audit
 * grouped hfc_see_also_gin with hfc_audit_pending_idx because both had zero
 * scans.  The latter still backs the remote-feature quarantine lane and must
 * survive this migration.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = join(HERE, '..', 'sql', '1082-drop-unused-work-items-see-also-gin.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 1082 not found at ${armed}[.DRAFT]`);
}

const MIGRATION_SQL = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'seealso1082' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      title text,
      tags text[] NOT NULL DEFAULT '{}',
      see_also text[] NOT NULL DEFAULT '{}',
      origin text NOT NULL DEFAULT 'local',
      audit_verdict text,
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
    );

    CREATE INDEX hfc_see_also_gin
      ON harness_shared.work_items USING gin (see_also);
    CREATE INDEX hfc_audit_pending_idx
      ON harness_shared.work_items (harness_slug)
      WHERE origin = 'remote'
        AND (audit_verdict IS NULL OR audit_verdict = 'pending');

    INSERT INTO harness_shared.work_items (
      workspace_id, harness_slug, feature_id, title, see_also
    ) VALUES
      ('ws', 'pot', 'F-source', 'source', ARRAY['F-related']),
      ('ws', 'pot', 'F-related', 'related', ARRAY[]::text[]);
  `);

  const before = await sql<{ indexname: string }[]>`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'harness_shared'
       AND tablename = 'work_items'
       AND indexname IN ('hfc_see_also_gin', 'hfc_audit_pending_idx')
     ORDER BY indexname`;
  expect(before.map((row) => row.indexname)).toEqual([
    'hfc_audit_pending_idx',
    'hfc_see_also_gin',
  ]);

  // Applying twice proves the IF EXISTS contract as well as the first drop.
  await sql.unsafe(MIGRATION_SQL);
  await sql.unsafe(MIGRATION_SQL);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1082 — work_items see_also GIN retirement', () => {
  it('drops only hfc_see_also_gin and retains the live auditor partial index', async () => {
    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
        FROM pg_indexes
       WHERE schemaname = 'harness_shared'
         AND tablename = 'work_items'
         AND indexname IN ('hfc_see_also_gin', 'hfc_audit_pending_idx')
       ORDER BY indexname`;

    expect(indexes).toEqual([
      expect.objectContaining({
        indexname: 'hfc_audit_pending_idx',
        indexdef: expect.stringContaining("origin = 'remote'::text"),
      }),
    ]);
  });

  it('preserves explicit see-also relation data and its identity lookup consumer', async () => {
    const [source] = await sql<{ see_also: string[] }[]>`
      SELECT see_also
        FROM harness_shared.work_items
       WHERE workspace_id = 'ws'
         AND harness_slug = 'pot'
         AND feature_id = 'F-source'`;
    const related = await sql<{ feature_id: string }[]>`
      SELECT feature_id
        FROM harness_shared.work_items
       WHERE workspace_id = 'ws'
         AND harness_slug = 'pot'
         AND feature_id = ANY(${source.see_also}::text[])
       ORDER BY feature_id`;

    expect(source.see_also).toEqual(['F-related']);
    expect(related).toEqual([{ feature_id: 'F-related' }]);
  });
});
