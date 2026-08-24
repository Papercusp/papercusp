/**
 * Migration 939 — collapse split owner-loop fire state and enforce role identity.
 *
 * Runs the real migration against fresh Postgres.  The fixture deliberately puts
 * the newest fire, lowest error count, and newest withhold on different split rows
 * so a superficially plausible "keep one row" implementation cannot pass.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '939-owner-loop-role-uniqueness.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 939 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'ownerloop939' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.autoloop_state (
      harness_slug text NOT NULL,
      role text DEFAULT 'director' NOT NULL,
      last_fired_at timestamptz DEFAULT now() NOT NULL,
      last_status text,
      consecutive_errors integer DEFAULT 0 NOT NULL,
      workspace_id text DEFAULT '' NOT NULL,
      last_withheld_at timestamptz,
      last_withheld_reason text,
      last_withheld_detail text,
      CONSTRAINT autoloop_state_pkey PRIMARY KEY (workspace_id, harness_slug, role)
    );

    INSERT INTO harness_shared.autoloop_state
      (workspace_id, harness_slug, role, last_fired_at, last_status,
       consecutive_errors, last_withheld_at, last_withheld_reason,
       last_withheld_detail)
    VALUES
      ('ws-old', 'h-old', 'loop-su-split', '2026-01-01T00:00:00Z',
       'error: old', 7, '2026-01-05T00:00:00Z', 'old-withhold', 'old detail'),
      ('ws-current', 'h-current', 'loop-su-split', '2026-01-03T00:00:00Z',
       'ok', 0, '2026-01-04T00:00:00Z', 'middle-withhold', 'middle detail'),
      ('ws-old', 'h-middle', 'loop-su-split', '2026-01-02T00:00:00Z',
       'error: middle', 3, '2026-01-06T00:00:00Z', 'latest-withhold', 'latest detail'),
      ('ws-a', 'h-a', 'director', '2026-01-01T00:00:00Z', 'ok', 0, NULL, NULL, NULL),
      ('ws-a', 'h-b', 'director', '2026-01-01T00:00:00Z', 'ok', 0, NULL, NULL, NULL);
  `);
  await sql.unsafe(migrationSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 939 — owner-loop role-only identity', () => {
  it('collapses every split into the newest survivor with conservative merged state', async () => {
    const rows = await sql<
      Array<{
        workspace_id: string;
        harness_slug: string;
        last_fired_at: Date;
        last_status: string | null;
        consecutive_errors: number;
        last_withheld_at: Date | null;
        last_withheld_reason: string | null;
        last_withheld_detail: string | null;
      }>
    >`
      SELECT workspace_id, harness_slug, last_fired_at, last_status,
             consecutive_errors, last_withheld_at, last_withheld_reason,
             last_withheld_detail
        FROM harness_shared.autoloop_state
       WHERE role = 'loop-su-split'`;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: 'ws-current',
      harness_slug: 'h-current',
      last_status: 'ok',
      consecutive_errors: 0,
      last_withheld_reason: 'latest-withhold',
      last_withheld_detail: 'latest detail',
    });
    expect(rows[0].last_fired_at.toISOString()).toBe('2026-01-03T00:00:00.000Z');
    expect(rows[0].last_withheld_at?.toISOString()).toBe('2026-01-06T00:00:00.000Z');
  });

  it('enforces one loop-su row globally, even across workspace and harness metadata', async () => {
    await expect(sql`
      INSERT INTO harness_shared.autoloop_state
        (workspace_id, harness_slug, role, last_status, consecutive_errors)
      VALUES ('ws-another', 'h-another', 'loop-su-split', 'attempt', 0)`
    ).rejects.toThrow(/autoloop_state_owner_role_uidx|duplicate key/i);
  });

  it('keeps ordinary harness roles outside the partial uniqueness fence', async () => {
    const rows = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
        FROM harness_shared.autoloop_state
       WHERE role = 'director'`;
    expect(rows).toEqual([{ count: 2 }]);

    await expect(sql`
      INSERT INTO harness_shared.autoloop_state
        (workspace_id, harness_slug, role, last_status, consecutive_errors)
      VALUES ('ws-a', 'h-c', 'director', 'ok', 0)`
    ).resolves.not.toThrow();
  });

  it('creates the intended partial UNIQUE index and is idempotent', async () => {
    const indexes = await sql<Array<{ indexdef: string }>>`
      SELECT indexdef
        FROM pg_indexes
       WHERE schemaname = 'harness_shared'
         AND indexname = 'autoloop_state_owner_role_uidx'`;
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toContain('UNIQUE INDEX');
    expect(indexes[0].indexdef).toContain('(role)');
    expect(indexes[0].indexdef).toMatch(/WHERE .*loop-su-%/);

    await expect(sql.unsafe(migrationSql)).resolves.not.toThrow();
    const ownerRows = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
        FROM harness_shared.autoloop_state
       WHERE role = 'loop-su-split'`;
    expect(ownerRows).toEqual([{ count: 1 }]);
  });
});
