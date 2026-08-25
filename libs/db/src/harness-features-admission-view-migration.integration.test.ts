/**
 * EI-21465624967193102 — real-Postgres chronology guard for migration 966.
 *
 * Migration 374 created harness_features_consolidated with SELECT * before
 * migration 944 widened the base work_items table. PostgreSQL freezes that
 * expanded row type, so feature-family admission reads failed even though the
 * base columns existed. This fixture recreates that order, proves the failure
 * before 966, then verifies the repaired pending/auto diagnostic and idempotence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(HERE, '..', 'sql');

function migrationPath(filename: string): string {
  const armed = path.join(SQL_DIR, filename);
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration not found at ${armed}[.DRAFT]`);
}

const migration944 = readFileSync(
  migrationPath('944-work-queue-admission-dedup.sql'),
  'utf8',
);
const migration966 = readFileSync(
  migrationPath('966-expose-admission-on-harness-features-consolidated-view.sql'),
  'utf8',
);

let db: MigratedTestDb;
let sql: Sql;
let preRepairColumns: string[];
let preRepairError = '';

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'hfc-admission-966' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });

  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      item_kind text NOT NULL,
      created_ts bigint,
      title text,
      status text,
      PRIMARY KEY (harness_slug, feature_id)
    );
    CREATE VIEW harness_shared.harness_features_consolidated AS
      SELECT * FROM harness_shared.work_items
       WHERE item_kind NOT IN ('bug', 'change', 'task')
       WITH CASCADED CHECK OPTION;
  `);

  // Recreate the live chronology: the view exists first, then 944 adds the base
  // columns. The view's expanded SELECT * row type must remain unchanged here.
  await sql.unsafe(migration944).simple();
  preRepairColumns = (
    await sql<Array<{ column_name: string }>>`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name = 'harness_features_consolidated'
         AND column_name IN ('admission', 'admitted_at', 'admitted_by')
       ORDER BY ordinal_position`
  ).map((row) => row.column_name);
  try {
    await sql.unsafe(
      'SELECT admission FROM harness_shared.harness_features_consolidated LIMIT 1',
    );
  } catch (error) {
    preRepairError = error instanceof Error ? error.message : String(error);
  }

  await sql.unsafe(migration966).simple();
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 966 — feature admission view chronology', () => {
  it('repairs the frozen post-944 view row type without rewriting the base table', async () => {
    expect(preRepairColumns).toEqual([]);
    expect(preRepairError).toMatch(/column ["']?admission["']? does not exist/i);

    const columns = await sql<Array<{ column_name: string }>>`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name = 'harness_features_consolidated'
         AND column_name IN ('admission', 'admitted_at', 'admitted_by')
       ORDER BY ordinal_position`;
    expect(columns.map((row) => row.column_name)).toEqual([
      'admission',
      'admitted_at',
      'admitted_by',
    ]);

    const [relation] = await sql<Array<{ relkind: string }>>`
      SELECT relkind
        FROM pg_class
       WHERE oid = 'harness_shared.harness_features_consolidated'::regclass`;
    expect(relation).toEqual({ relkind: 'v' });
  });

  it('keeps pending features hidden from the same preflight that admits auto features', async () => {
    await sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, item_kind, created_ts, title,
         status, admission, admitted_at, admitted_by)
      VALUES
        ('ws', 'papercusp', 'F-PENDING', 'feature', 1, 'pending', 'todo',
         'pending', NULL, NULL),
        ('ws', 'papercusp', 'F-AUTO', 'feature', 2, 'auto', 'todo',
         'auto', now(), 'bypass:plan-item')`;

    const rows = await sql<
      Array<{
        feature_id: string;
        admission: string;
        admitted_at: Date | null;
        admitted_by: string | null;
      }>
    >`
      SELECT feature_id, admission, admitted_at, admitted_by
        FROM harness_shared.harness_features_consolidated
       WHERE admission IS DISTINCT FROM 'pending'
       ORDER BY feature_id`;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      feature_id: 'F-AUTO',
      admission: 'auto',
      admitted_by: 'bypass:plan-item',
    });
    expect(rows[0]?.admitted_at).toBeInstanceOf(Date);

    const [pending] = await sql<Array<{ admission: string }>>`
      SELECT admission
        FROM harness_shared.work_items
       WHERE feature_id = 'F-PENDING'`;
    expect(pending).toEqual({ admission: 'pending' });
  });

  it('is idempotent and preserves rows written through the compatibility view', async () => {
    await expect(sql.unsafe(migration966).simple()).resolves.not.toThrow();
    const rows = await sql<Array<{ feature_id: string; admission: string }>>`
      SELECT feature_id, admission
        FROM harness_shared.harness_features_consolidated
       ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: 'F-AUTO', admission: 'auto' },
      { feature_id: 'F-PENDING', admission: 'pending' },
    ]);
  });
});
