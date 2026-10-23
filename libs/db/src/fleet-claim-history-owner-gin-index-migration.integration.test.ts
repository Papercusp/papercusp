import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_NAME = '1563-fleet-claim-history-owner-gin-index.sql';

function migrationPath(): string {
  const armed = join(HERE, '..', 'sql', MIGRATION_NAME);
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration ${MIGRATION_NAME} not found at ${armed}[.DRAFT]`);
}

const MIGRATION_SQL = readFileSync(migrationPath(), 'utf8');
const MEMBER_IDS = ['member-a', 'member-b'];
const SINCE = '2026-10-20T10:00:00Z';
const SNAPSHOT = '2026-10-20T11:30:00Z';

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'fleet-claim-history-owner-gin-1563' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      worked_by_history jsonb NOT NULL DEFAULT '[]'::jsonb,
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
    );
  `);
  await sql.unsafe(MIGRATION_SQL);
  await sql.unsafe(MIGRATION_SQL);
  await sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, worked_by_history)
    VALUES
      ('ws-a', 'papercusp', 'F-a', ${sql.json([
        { owner: 'member-a', at: '2026-10-20T10:00:00Z' },
        { owner: 'member-a', at: '2026-10-20T11:00:00Z' },
        { owner: 'outsider', at: '2026-10-20T11:15:00Z' },
      ])}::jsonb),
      ('ws-a', 'papercusp', 'F-b', ${sql.json([
        { owner: 'member-b', at: '2026-10-20T10:30:00Z' },
      ])}::jsonb),
      ('ws-a', 'papercusp', 'F-old', ${sql.json([
        { owner: 'member-a', at: '2026-10-20T09:59:59Z' },
      ])}::jsonb),
      ('ws-a', 'other-harness', 'F-other-harness', ${sql.json([
        { owner: 'member-a', at: '2026-10-20T10:45:00Z' },
      ])}::jsonb),
      ('ws-b', 'papercusp', 'F-other-workspace', ${sql.json([
        { owner: 'member-a', at: '2026-10-20T10:50:00Z' },
      ])}::jsonb),
      ('ws-a', 'papercusp', 'F-empty', '[]'::jsonb),
      ('ws-a', 'papercusp', 'F-malformed', '{"owner":"member-a"}'::jsonb)
  `;
  // Make owner containment selective within the queried workspace/harness so
  // EXPLAIN proves the partial GIN index is usable before array expansion.
  await sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, worked_by_history)
    SELECT 'ws-a', 'papercusp', 'F-unrelated-' || n::text,
           jsonb_build_array(jsonb_build_object(
             'owner', 'outsider-' || n::text,
             'at', '2026-10-20T10:30:00Z'
           ))
      FROM generate_series(1, 1000) AS n
  `;
  await sql`ANALYZE harness_shared.work_items`;
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1563 — fleet claim-history owner containment index', () => {
  it('creates the partial jsonb_path_ops index used by the history readers', async () => {
    const indexes = await sql<{ indexdef: string }[]>`
      SELECT indexdef
        FROM pg_indexes
       WHERE schemaname = 'harness_shared'
         AND tablename = 'work_items'
         AND indexname = 'work_items_worked_by_history_owner_gin_idx'
    `;

    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain('USING gin (worked_by_history jsonb_path_ops)');
    expect(indexes[0]?.indexdef).toContain("jsonb_typeof(worked_by_history) = 'array'::text");
    expect(indexes[0]?.indexdef).toContain("worked_by_history <> '[]'::jsonb");
  });

  it('uses owner containment before expansion and preserves workspace, harness, and time scope', async () => {
    await sql`SET enable_seqscan = off`;
    const seededRows = await sql<Array<{
      feature_id: string;
      history_type: string;
      history: string;
      member_a: boolean;
      member_b: boolean;
    }>>`
      SELECT feature_id,
             jsonb_typeof(worked_by_history) AS history_type,
             worked_by_history::text AS history,
             worked_by_history @> ${sql.json([{ owner: MEMBER_IDS[0] }])}::jsonb AS member_a,
             worked_by_history @> ${sql.json([{ owner: MEMBER_IDS[1] }])}::jsonb AS member_b
        FROM harness_shared.work_items
       WHERE workspace_id = 'ws-a'
         AND harness_slug = 'papercusp'
         AND feature_id = ANY(${sql.array(['F-a', 'F-b', 'F-old'])}::text[])
       ORDER BY feature_id
    `;
    expect(seededRows, JSON.stringify(seededRows)).toMatchObject([
      { feature_id: 'F-a', history_type: 'array', member_a: true, member_b: false },
      { feature_id: 'F-b', history_type: 'array', member_a: false, member_b: true },
      { feature_id: 'F-old', history_type: 'array', member_a: true, member_b: false },
    ]);
    const plan = await sql<Array<{ 'QUERY PLAN': string }>>`
      EXPLAIN
      SELECT h.value->>'owner' AS owner_id, wi.feature_id, h.value->>'at' AS at
        FROM harness_shared.work_items wi
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(wi.worked_by_history) = 'array'
            THEN wi.worked_by_history ELSE '[]'::jsonb END
        ) h(value)
       WHERE wi.workspace_id = 'ws-a'
         AND jsonb_typeof(wi.worked_by_history) = 'array'
         AND wi.worked_by_history <> '[]'::jsonb
         AND (
           wi.worked_by_history @> ${sql.json([{ owner: MEMBER_IDS[0] }])}::jsonb
           OR wi.worked_by_history @> ${sql.json([{ owner: MEMBER_IDS[1] }])}::jsonb
         )
         AND h.value->>'owner' = ANY(${sql.array(MEMBER_IDS)}::text[])
         AND (h.value->>'at')::timestamptz >= ${SINCE}::timestamptz
         AND (h.value->>'at')::timestamptz <= ${SNAPSHOT}::timestamptz
         AND wi.harness_slug = 'papercusp'
    `;
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'work_items_worked_by_history_owner_gin_idx',
    );

    const contained = await sql<Array<{ feature_id: string }>>`
      SELECT feature_id
        FROM harness_shared.work_items wi
       WHERE wi.workspace_id = 'ws-a'
         AND wi.harness_slug = 'papercusp'
         AND jsonb_typeof(wi.worked_by_history) = 'array'
         AND wi.worked_by_history <> '[]'::jsonb
         AND (
           wi.worked_by_history @> ${sql.json([{ owner: MEMBER_IDS[0] }])}::jsonb
           OR wi.worked_by_history @> ${sql.json([{ owner: MEMBER_IDS[1] }])}::jsonb
         )
       ORDER BY feature_id
    `;
    expect(contained.map((row) => row.feature_id)).toEqual(['F-a', 'F-b', 'F-old']);

    const rows = await sql<Array<{ owner_id: string; feature_id: string; at: string }>>`
      SELECT h.value->>'owner' AS owner_id, wi.feature_id, h.value->>'at' AS at
        FROM harness_shared.work_items wi
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(wi.worked_by_history) = 'array'
            THEN wi.worked_by_history ELSE '[]'::jsonb END
        ) h(value)
       WHERE wi.workspace_id = 'ws-a'
         AND jsonb_typeof(wi.worked_by_history) = 'array'
         AND wi.worked_by_history <> '[]'::jsonb
         AND (
           wi.worked_by_history @> ${sql.json([{ owner: MEMBER_IDS[0] }])}::jsonb
           OR wi.worked_by_history @> ${sql.json([{ owner: MEMBER_IDS[1] }])}::jsonb
         )
         AND h.value->>'owner' = ANY(${sql.array(MEMBER_IDS)}::text[])
         AND (h.value->>'at')::timestamptz >= ${SINCE}::timestamptz
         AND (h.value->>'at')::timestamptz <= ${SNAPSHOT}::timestamptz
         AND wi.harness_slug = 'papercusp'
       ORDER BY (h.value->>'at')::timestamptz DESC, wi.feature_id`;

    expect(rows).toEqual([
      { owner_id: 'member-a', feature_id: 'F-a', at: '2026-10-20T11:00:00Z' },
      { owner_id: 'member-b', feature_id: 'F-b', at: '2026-10-20T10:30:00Z' },
      { owner_id: 'member-a', feature_id: 'F-a', at: '2026-10-20T10:00:00Z' },
    ]);
  });
});
