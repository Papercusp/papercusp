/**
 * WI-10003762 — the standing-watch branch in fireAwaitsForKey must use an
 * exact-key index that does not depend on the one-shot fired_at predicate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_NAME = 'event_awaits_standing_exact_key_active';

function migrationPath(): string {
  const armed = join(HERE, '..', 'sql', '1274-event-await-standing-exact-key-index.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 1274 not found at ${armed}[.DRAFT]`);
}

const MIGRATION_SQL = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

async function standingPlan(): Promise<string> {
  const rows = await sql<{ 'QUERY PLAN': string }[]>`
    EXPLAIN (FORMAT TEXT)
    SELECT id
      FROM harness_shared.event_awaits
     WHERE workspace_id = 'default'
       AND event_key = 'work-item:done:target'
       AND once = false
       AND cancelled_at IS NULL
       AND (expires_ts IS NULL OR expires_ts > now())
       AND policy <> 'announce'`;
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'eventawaitstanding1274' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.event_awaits (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default',
      event_key text NOT NULL,
      once boolean NOT NULL DEFAULT true,
      fired_at timestamptz,
      cancelled_at timestamptz,
      expires_ts timestamptz,
      policy text NOT NULL DEFAULT 'wake'
    );

    -- Reproduce the live one-shot index that cannot cover the standing branch.
    CREATE INDEX idx_event_awaits_active_key
      ON harness_shared.event_awaits (workspace_id, event_key)
      WHERE fired_at IS NULL AND cancelled_at IS NULL;

    INSERT INTO harness_shared.event_awaits
      (workspace_id, event_key, once, expires_ts, policy)
    SELECT 'default', 'work-item:done:' || n::text, (n % 2 = 0), now() + interval '1 day', 'wake'
      FROM generate_series(1, 100000) AS n;

    INSERT INTO harness_shared.event_awaits
      (workspace_id, event_key, once, expires_ts, policy)
    VALUES ('default', 'work-item:done:target', false, NULL, 'wake');
  `);
  await sql.unsafe('ANALYZE harness_shared.event_awaits');
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1274 — event await standing exact-key index', () => {
  it('changes the standing exact-key plan from a table scan to the partial index', async () => {
    const before = await standingPlan();
    expect(before).toMatch(/Seq Scan on event_awaits/);
    expect(before).not.toContain(INDEX_NAME);

    await sql.unsafe(MIGRATION_SQL);
    await sql.unsafe(MIGRATION_SQL); // CREATE INDEX IF NOT EXISTS is safe to reapply.
    await sql.unsafe('ANALYZE harness_shared.event_awaits');

    const indexes = await sql<{ indexdef: string }[]>`
      SELECT indexdef
        FROM pg_indexes
       WHERE schemaname = 'harness_shared'
         AND tablename = 'event_awaits'
         AND indexname = ${INDEX_NAME}`;
    expect(indexes).toHaveLength(1);
    expect(indexes[0].indexdef).toContain('(workspace_id, event_key)');
    expect(indexes[0].indexdef).toContain('once = false');
    expect(indexes[0].indexdef).toContain('cancelled_at IS NULL');

    const after = await standingPlan();
    expect(after).toMatch(new RegExp(`Index Scan.*${INDEX_NAME}|Bitmap Index Scan.*${INDEX_NAME}`));
    expect(after).not.toMatch(/Seq Scan on event_awaits/);
  });
});
