/**
 * Migration 1107 — derived plan revision snapshot identity.
 *
 * The additive column must hash the bytes actually persisted in
 * `content_snapshot`, without changing the existing canonical `content_hash`
 * contract or breaking writers that predate the column.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '1107-plan-revisions-content-snapshot-hash.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 1107 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'planrevision1107' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE harness_shared.plan_revisions (
      id BIGSERIAL PRIMARY KEY,
      plan_slug TEXT NOT NULL,
      seq INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      content_snapshot TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT 0
    );
  `);
  await sql.unsafe(migrationSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1107 — plan revision content snapshot hash', () => {
  it('derives snapshot hashes while preserving the canonical content_hash value', async () => {
    await sql`
      INSERT INTO harness_shared.plan_revisions
        (plan_slug, seq, content_hash, content_snapshot, created_at)
      VALUES
        ('plan-a', 1, 'canonical-body-hash', 'body-only snapshot', 1),
        ('plan-a', 2, 'canonical-body-hash', 'body-only snapshot with template_data', 2)
    `;

    const rows = await sql<{
      seq: number;
      content_hash: string;
      content_snapshot_hash: string;
      expected_hash: string;
    }[]>`
      SELECT seq, content_hash, content_snapshot_hash,
             encode(digest(content_snapshot, 'sha256'), 'hex') AS expected_hash
        FROM harness_shared.plan_revisions
       WHERE plan_slug = 'plan-a'
       ORDER BY seq
    `;

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.content_snapshot_hash === row.expected_hash)).toBe(true);
    expect(rows[0]?.content_hash).toBe('canonical-body-hash');
    expect(rows[1]?.content_hash).toBe('canonical-body-hash');
    expect(rows[0]?.content_snapshot_hash).not.toBe(rows[1]?.content_snapshot_hash);
  });

  it('recomputes on snapshot updates and rejects caller-supplied values', async () => {
    const [inserted] = await sql<{ id: number; content_snapshot_hash: string }[]>`
      INSERT INTO harness_shared.plan_revisions
        (plan_slug, seq, content_hash, content_snapshot, created_at)
      VALUES ('plan-b', 1, 'body-hash', 'initial snapshot', 1)
      RETURNING id, content_snapshot_hash
    `;
    expect(inserted?.content_snapshot_hash).toBeDefined();

    await sql`
      UPDATE harness_shared.plan_revisions
         SET content_snapshot = 'updated snapshot'
       WHERE id = ${inserted.id}
    `;
    const [updated] = await sql<{ content_snapshot_hash: string; expected_hash: string }[]>`
      SELECT content_snapshot_hash,
             encode(digest(content_snapshot, 'sha256'), 'hex') AS expected_hash
        FROM harness_shared.plan_revisions
       WHERE id = ${inserted.id}
    `;
    expect(updated?.content_snapshot_hash).toBe(updated?.expected_hash);
    expect(updated?.content_snapshot_hash).not.toBe(inserted.content_snapshot_hash);

    await expect(sql`
      UPDATE harness_shared.plan_revisions
         SET content_snapshot_hash = 'caller-supplied'
       WHERE id = ${inserted.id}
    `).rejects.toThrow(/generated|cannot update|only be updated to DEFAULT/i);
    await expect(sql`
      INSERT INTO harness_shared.plan_revisions
        (plan_slug, seq, content_hash, content_snapshot, content_snapshot_hash, created_at)
      VALUES ('plan-b', 2, 'body-hash', 'another snapshot', 'caller-supplied', 2)
    `).rejects.toThrow(/generated|DEFAULT|cannot insert/i);
  });

  it('is idempotent and remains compatible with an old writer', async () => {
    await sql.unsafe(migrationSql);
    await sql`
      INSERT INTO harness_shared.plan_revisions
        (plan_slug, seq, content_hash, content_snapshot, created_at)
      VALUES ('old-writer-plan', 1, 'old-body-hash', 'old writer snapshot', 1)
    `;

    const [shape] = await sql<{
      column_count: number;
      generated: string;
      generation_expression: string | null;
    }[]>`
      SELECT
        count(*)::int AS column_count,
        max(is_generated) AS generated,
        max(generation_expression) AS generation_expression
        FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name = 'plan_revisions'
         AND column_name = 'content_snapshot_hash'
    `;
    expect(shape).toMatchObject({ column_count: 1, generated: 'ALWAYS' });
    expect(shape?.generation_expression).toMatch(/digest/i);

    const [row] = await sql<{ content_hash: string; content_snapshot_hash: string }[]>`
      SELECT content_hash, content_snapshot_hash
        FROM harness_shared.plan_revisions
       WHERE plan_slug = 'old-writer-plan'
    `;
    expect(row?.content_hash).toBe('old-body-hash');
    expect(row?.content_snapshot_hash).toBeDefined();
  });
});
