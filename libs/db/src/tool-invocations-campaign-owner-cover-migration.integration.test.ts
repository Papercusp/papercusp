import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_NAME = '1562-tool-invocations-campaign-owner-cover.sql';

function migrationPath(filename: string): string {
  const armed = join(HERE, '..', 'sql', filename);
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration ${filename} not found at ${armed}[.DRAFT]`);
}

const MIGRATION_SQL = readFileSync(migrationPath(MIGRATION_NAME), 'utf8');

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'tool-invocations-campaign-owner-cover-1562' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.tool_invocations (
      id bigint PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      coord_owner_id text,
      invoked_at timestamptz NOT NULL,
      status text NOT NULL
    );
  `);
  await sql.unsafe(MIGRATION_SQL);
  await sql`
    INSERT INTO harness_shared.tool_invocations
      (id, workspace_id, harness_slug, coord_owner_id, invoked_at, status)
    VALUES
      (1, 'ws-a', 'papercusp', 'member-a', '2026-10-20T10:00:00Z', 'ok'),
      (2, 'ws-a', 'papercusp', 'member-a', '2026-10-20T11:00:00Z', 'error'),
      (3, 'ws-a', 'other-harness', 'member-a', '2026-10-20T12:00:00Z', 'ok'),
      (4, 'ws-b', 'papercusp', 'member-a', '2026-10-20T13:00:00Z', 'ok'),
      (5, 'ws-a', 'papercusp', 'member-b', '2026-10-20T14:00:00Z', 'ok'),
      (6, 'ws-a', 'papercusp', 'member-a', '2026-10-19T23:59:59Z', 'ok')
  `;
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1562 — fleet campaign speaking index', () => {
  it('covers the workspace, owner, time, harness, and status columns', async () => {
    const indexes = await sql<{ indexdef: string }[]>`
      SELECT indexdef
        FROM pg_indexes
       WHERE schemaname = 'harness_shared'
         AND tablename = 'tool_invocations'
         AND indexname = 'tool_invocations_campaign_owner_cover_idx'
    `;

    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain('(workspace_id, coord_owner_id, invoked_at DESC)');
    expect(indexes[0]?.indexdef).toContain('INCLUDE (harness_slug, status)');
    expect(indexes[0]?.indexdef).toContain('WHERE (coord_owner_id IS NOT NULL)');
  });

  it('serves the exact speaking aggregate without changing its scope', async () => {
    await sql`SET enable_seqscan = off`;
    const plan = await sql<Array<{ 'QUERY PLAN': string }>>`
      EXPLAIN
      SELECT count(*)::bigint AS calls,
             count(DISTINCT coord_owner_id)::bigint AS owners,
             max(invoked_at) AS latest_at
        FROM harness_shared.tool_invocations
       WHERE workspace_id = 'ws-a'
         AND coord_owner_id = ANY(ARRAY['member-a', 'member-b']::text[])
         AND invoked_at >= '2026-10-20T00:00:00Z'::timestamptz
         AND harness_slug = 'papercusp'
    `;
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'tool_invocations_campaign_owner_cover_idx',
    );

    const totals = await sql<Array<{ calls: string; owners: string; latest_at: Date }>>`
      SELECT count(*)::bigint AS calls,
             count(DISTINCT coord_owner_id)::bigint AS owners,
             max(invoked_at) AS latest_at
        FROM harness_shared.tool_invocations
       WHERE workspace_id = 'ws-a'
         AND coord_owner_id = ANY(ARRAY['member-a', 'member-b']::text[])
         AND invoked_at >= '2026-10-20T00:00:00Z'::timestamptz
         AND harness_slug = 'papercusp'
    `;
    expect(totals[0]).toMatchObject({ calls: '3', owners: '2' });
    expect(totals[0]?.latest_at.toISOString()).toBe('2026-10-20T14:00:00.000Z');
  });

  it('is safe to reapply after an online concurrent prebuild', async () => {
    await expect(sql.unsafe(MIGRATION_SQL)).resolves.not.toThrow();
    const indexes = await sql<{ count: string }[]>`
      SELECT count(*)::bigint AS count
        FROM pg_indexes
       WHERE schemaname = 'harness_shared'
         AND tablename = 'tool_invocations'
         AND indexname = 'tool_invocations_campaign_owner_cover_idx'
    `;
    expect(indexes[0]?.count).toBe('1');
  });
});
