import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_NAME = '1625-legacy-needs-human-candidate-index.sql';
const INDEX_NAME = 'work_items_legacy_needs_human_candidates_idx';

function migrationPath(): string {
  const armed = join(HERE, '..', 'sql', MIGRATION_NAME);
  if (existsSync(armed)) return armed;
  const draft = armed + '.DRAFT';
  if (existsSync(draft)) return draft;
  throw new Error('migration ' + MIGRATION_NAME + ' not found at ' + armed + '[.DRAFT]');
}

const MIGRATION_SQL = readFileSync(migrationPath(), 'utf8');
const CANDIDATE_QUERY = [
  'SELECT workspace_id, harness_slug, feature_id, status, item_kind, taken_by, payload',
  'FROM harness_shared.work_items',
  "WHERE workspace_id = ANY(ARRAY['ws-a','default']::text[])",
  "AND item_kind = ANY(ARRAY['bug','change','task','cleanup']::text[])",
  "AND status <> ALL(ARRAY['passed','deprecated','done','dropped','resolved','closed']::text[])",
  "AND status IS DISTINCT FROM 'needs-human'",
  "AND COALESCE(payload, '{}'::jsonb) ->> 'needsHuman' = 'true'",
  "AND COALESCE(payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'",
  "AND COALESCE(payload, '{}'::jsonb) ->> '_lane' IS DISTINCT FROM 'observation'",
  "AND COALESCE(payload, '{}'::jsonb) ->> 'needsOwnerAction' IS DISTINCT FROM 'true'",
  "AND NOT (COALESCE(payload, '{}'::jsonb) ? 'humanCapability')",
  "AND (NOT (COALESCE(payload, '{}'::jsonb) ? 'externalBlockers')",
  "OR COALESCE(payload, '{}'::jsonb) -> 'externalBlockers' = 'null'::jsonb",
  "OR (jsonb_typeof(COALESCE(payload, '{}'::jsonb) -> 'externalBlockers') = 'array'",
  "AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(payload, '{}'::jsonb) -> 'externalBlockers') b",
  "WHERE jsonb_typeof(b) IS DISTINCT FROM 'object' OR b ->> 'status' IS NULL OR lower(b ->> 'status') = 'active')))",
  'ORDER BY updated_ts ASC NULLS FIRST, harness_slug ASC NULLS FIRST, feature_id ASC',
  'LIMIT 101',
  'FOR UPDATE SKIP LOCKED',
].join('\n');

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'legacy-needs-human-candidate-1625' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(
    'CREATE SCHEMA harness_shared; ' +
      'CREATE TABLE harness_shared.work_items (' +
      'workspace_id text NOT NULL, harness_slug text, feature_id text NOT NULL, ' +
      'status text, item_kind text, taken_by text, updated_ts bigint, payload jsonb)',
  );
  await sql.unsafe(MIGRATION_SQL);
  await sql.unsafe(MIGRATION_SQL);
  await sql.unsafe(
    "INSERT INTO harness_shared.work_items " +
      '(workspace_id, harness_slug, feature_id, status, item_kind, taken_by, updated_ts, payload) VALUES ' +
      "('ws-a','papercusp','clear-me','open','bug',NULL,1,jsonb_build_object('needsHuman',true)), " +
      "('ws-a','papercusp','needs-human','needs-human','bug',NULL,2,jsonb_build_object('needsHuman',true)), " +
      "('ws-a','papercusp','owner-action','open','change',NULL,3,jsonb_build_object('needsHuman',true,'needsOwnerAction',true)), " +
      "('ws-a','papercusp','human-capability','open','task',NULL,4,jsonb_build_object('needsHuman',true,'humanCapability','credential')), " +
      "('ws-a','papercusp','active-blocker','open','task',NULL,5,jsonb_build_object('needsHuman',true,'externalBlockers',jsonb_build_array(jsonb_build_object('status','active')))), " +
      "('ws-a','papercusp','malformed-blocker','open','task',NULL,6,jsonb_build_object('needsHuman',true,'externalBlockers',jsonb_build_object('status','active'))), " +
      "('ws-a','papercusp','observation-lane','open','bug',NULL,7,jsonb_build_object('needsHuman',true,'lane','observation')), " +
      "('ws-a','papercusp','underscored-observation-lane','open','bug',NULL,8,jsonb_build_object('needsHuman',true,'_lane','observation')), " +
      "('ws-a','papercusp','terminal','done','bug',NULL,9,jsonb_build_object('needsHuman',true)), " +
      "('ws-a','papercusp','wrong-kind','open','feature',NULL,10,jsonb_build_object('needsHuman',true)), " +
      "('ws-b','papercusp','outside-workspace','open','bug',NULL,11,jsonb_build_object('needsHuman',true))",
  );
  await sql.unsafe(
    "INSERT INTO harness_shared.work_items " +
      '(workspace_id, harness_slug, feature_id, status, item_kind, updated_ts, payload) ' +
      "SELECT 'ws-a','papercusp','unrelated-' || n::text,'open','bug',100 + n,'{}'::jsonb " +
      'FROM generate_series(1, 1000) AS n',
  );
  await sql.unsafe('ANALYZE harness_shared.work_items');
  await sql.unsafe('SET enable_seqscan = off');
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1625 — legacy needsHuman candidate index', () => {
  it('creates the selective partial index idempotently', async () => {
    const indexes = (await sql.unsafe(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'harness_shared' " +
        "AND tablename = 'work_items' AND indexname = '" + INDEX_NAME + "'",
    )) as Array<{ indexdef: string }>;

    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain('updated_ts NULLS FIRST');
    expect(indexes[0]?.indexdef).toContain('harness_slug NULLS FIRST');
    expect(indexes[0]?.indexdef).toContain('needsHuman');
    expect(indexes[0]?.indexdef).toContain('true');
  });

  it('uses the index for the ordered query and preserves typed blocker filtering', async () => {
    const plan = (await sql.unsafe('EXPLAIN ' + CANDIDATE_QUERY)) as Array<{ 'QUERY PLAN': string }>;
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(INDEX_NAME);

    const rows = (await sql.unsafe(CANDIDATE_QUERY)) as Array<{ feature_id: string }>;
    expect(rows.map((row) => row.feature_id)).toEqual(['clear-me']);
  });
});
