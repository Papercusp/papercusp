/**
 * Real-PostgreSQL recurrence guard for migration 578 (temporal-lite memory).
 *
 * A schema-shape assertion cannot prove the migration is safe on the rows that
 * pre-date it. This fixture builds the exact pre-578 table, seeds ordinary
 * legacy memories plus mem0 entity rows, applies the real SQL twice, and proves
 * the nullable backfill contract remains data-preserving and idempotent.
 *
 * Run:
 *   npm run test:file -- libs/papercusp/libs/db/src/memory-canonical-temporal-lite-migration.integration.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_578 = readFileSync(
  join(HERE, '..', 'sql', '578-memory-canonical-temporal-lite.sql'),
  'utf8',
)
  // postgres-js speaks SQL, not psql meta-commands. The production migration
  // runner strips this directive too; retain every SQL statement verbatim.
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('\\'))
  .join('\n');

const LEGACY_ID = '11111111-1111-4111-8111-111111111111';
const NULLISH_ID = '22222222-2222-4222-8222-222222222222';
const ENTITY_ID = '33333333-3333-4333-8333-333333333333';

const PRE_578_DDL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE harness_shared.memory_canonical (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'memory578' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(PRE_578_DDL);
  await sql.unsafe(
    `INSERT INTO harness_shared.memory_canonical (id, payload, created_at, updated_at)
     VALUES
       ($1, $2::jsonb, '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z'),
       ($3, $4::jsonb, '2026-06-03T00:00:00Z', '2026-06-04T00:00:00Z'),
       ($5, $6::jsonb, '2026-06-05T00:00:00Z', '2026-06-06T00:00:00Z')`,
    [
      LEGACY_ID,
      JSON.stringify({ data: 'legacy fact', user_id: 'scope-a' }),
      NULLISH_ID,
      JSON.stringify({
        data: 'legacy payload with null temporal lookalikes',
        user_id: 'scope-a',
        valid_at: null,
        invalid_at: null,
        superseded_by: null,
      }),
      ENTITY_ID,
      JSON.stringify({
        data: 'Ada Lovelace',
        user_id: 'scope-a',
        entityType: 'PROPER',
        linkedMemoryIds: [LEGACY_ID],
      }),
    ],
  );
  await sql.unsafe(MIGRATION_578);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 578 — temporal-lite columns on pre-migration rows', () => {
  it('adds nullable timestamptz/timestamptz/uuid columns with no payload rewrite', async () => {
    const columns = (await sql`
      SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name = 'memory_canonical'
         AND column_name IN ('valid_at', 'invalid_at', 'superseded_by')
       ORDER BY column_name`) as unknown as Array<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>;

    expect(columns).toEqual([
      { column_name: 'invalid_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'superseded_by', data_type: 'uuid', is_nullable: 'YES' },
      { column_name: 'valid_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
    ]);

    const rows = (await sql`
      SELECT id::text AS id, payload, valid_at, invalid_at, superseded_by
        FROM harness_shared.memory_canonical
       ORDER BY id`) as unknown as Array<{
      id: string;
      payload: Record<string, unknown>;
      valid_at: Date | null;
      invalid_at: Date | null;
      superseded_by: string | null;
    }>;

    expect(rows.map((row) => row.id)).toEqual([LEGACY_ID, NULLISH_ID, ENTITY_ID]);
    expect(rows.every((row) => row.valid_at === null)).toBe(true);
    expect(rows.every((row) => row.invalid_at === null)).toBe(true);
    expect(rows.every((row) => row.superseded_by === null)).toBe(true);
    expect(rows[0].payload).toEqual({ data: 'legacy fact', user_id: 'scope-a' });
    // Payload keys with the same names are legacy data, not a backfill source.
    expect(rows[1].payload).toMatchObject({
      valid_at: null,
      invalid_at: null,
      superseded_by: null,
    });
    // Entity graph rows share the table but remain lifecycle-exempt at runtime.
    expect(rows[2].payload).toMatchObject({ entityType: 'PROPER' });
  });

  it('creates the partial current-row index over invalid_at IS NULL', async () => {
    const [row] = (await sql`
      SELECT indexdef
        FROM pg_indexes
       WHERE schemaname = 'harness_shared'
         AND tablename = 'memory_canonical'
         AND indexname = 'memory_canonical_current_idx'`) as unknown as Array<{
      indexdef: string;
    }>;

    expect(row?.indexdef).toContain('created_at DESC');
    expect(row?.indexdef).toContain('WHERE (invalid_at IS NULL)');
  });

  it('is idempotent and never resets a validity window already written', async () => {
    await sql`
      UPDATE harness_shared.memory_canonical
         SET valid_at = '2026-06-01T00:00:00Z',
             invalid_at = '2026-07-01T00:00:00Z',
             superseded_by = ${NULLISH_ID}::uuid
       WHERE id = ${LEGACY_ID}::uuid`;

    await expect(sql.unsafe(MIGRATION_578)).resolves.toBeDefined();

    const [row] = (await sql`
      SELECT valid_at::text, invalid_at::text, superseded_by::text
        FROM harness_shared.memory_canonical
       WHERE id = ${LEGACY_ID}::uuid`) as unknown as Array<{
      valid_at: string;
      invalid_at: string;
      superseded_by: string;
    }>;
    expect(Date.parse(row.valid_at)).toBe(Date.parse('2026-06-01T00:00:00Z'));
    expect(Date.parse(row.invalid_at)).toBe(Date.parse('2026-07-01T00:00:00Z'));
    expect(row.superseded_by).toBe(NULLISH_ID);
  });
});
