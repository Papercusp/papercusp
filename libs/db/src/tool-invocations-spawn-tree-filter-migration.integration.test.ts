/**
 * EI-21990784921297347 — migration 1162 exact spawn-id filtering.
 *
 * The exact spawn predicate must be applied while choosing candidates, before
 * the limit. This suite applies the real 460 function followed by migration
 * 1162 to a minimal fresh PostgreSQL schema and proves both the new filter and
 * compatibility for callers that omit it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));

function migrationPath(filename: string): string {
  const armed = join(HERE, '..', 'sql', filename);
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration ${filename} not found at ${armed}[.DRAFT]`);
}

const BASE_FUNCTION_SQL = readFileSync(
  migrationPath('460-tool-invocations-spawn-tree-function.sql'),
  'utf8',
);
const FILTER_MIGRATION_SQL = readFileSync(
  migrationPath('1162-tool-invocations-spawn-tree-spawn-id-filter.sql'),
  'utf8',
);

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'spawn-tree-filter-1162' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.tool_invocations (
      id bigint PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plugin_name text NOT NULL,
      tool_name text NOT NULL,
      role text NOT NULL,
      feature_id text,
      chunk_id text,
      run_id text,
      spawn_id text NOT NULL,
      parent_spawn_id text,
      window_key text NOT NULL,
      invoked_at timestamptz NOT NULL,
      duration_ms integer,
      status text NOT NULL,
      output_ref text,
      output_size bigint,
      error_message text
    );
    CREATE INDEX tool_invocations_telemetry_idx
      ON harness_shared.tool_invocations (workspace_id, harness_slug, invoked_at DESC);
  `);
  await sql.unsafe(BASE_FUNCTION_SQL);
  await sql.unsafe(FILTER_MIGRATION_SQL);
  await sql`
    INSERT INTO harness_shared.tool_invocations
      (id, workspace_id, harness_slug, plugin_name, tool_name, role, run_id,
       spawn_id, parent_spawn_id, window_key, invoked_at, duration_ms, status)
    VALUES
      (1, 'ws-a', 'harness-a', 'test', 'root', 'worker', 'run-root',
       'target-root', NULL, 'run:root', '2026-09-01T00:00:00Z', 1, 'ok'),
      (2, 'ws-a', 'harness-a', 'test', 'child', 'worker', 'run-child',
       'target-child', 'target-root', 'run:child', '2026-09-02T00:00:00Z', 2, 'ok'),
      (3, 'ws-a', 'harness-a', 'test', 'newer-other', 'worker', 'run-other',
       'other-root', NULL, 'run:other', '2026-09-03T00:00:00Z', 3, 'ok'),
      (4, 'ws-b', 'harness-a', 'test', 'other-workspace', 'worker', 'run-ws-b',
       'target-child', NULL, 'run:ws-b', '2026-09-04T00:00:00Z', 4, 'ok'),
      (5, 'ws-a', 'other-harness', 'test', 'other-harness', 'worker', 'run-other-harness',
       'target-child', NULL, 'run:other-harness', '2026-09-05T00:00:00Z', 5, 'ok'),
      (6, 'ws-a', 'harness-a', 'test', 'target-timeout', 'worker', 'run-timeout',
       'target-child', 'target-root', 'run:timeout', '2026-09-06T00:00:00Z', 6, 'timeout')
  `;
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

type TreeRow = {
  // postgres-js preserves PostgreSQL bigint values as strings by default.
  id: string;
  spawn_id: string;
  parent_spawn_id: string | null;
  depth: number;
  root_spawn_id: string;
};

const args = {
  harness: 'harness-a',
  since: new Date('2026-08-01T00:00:00Z'),
  workspace: 'ws-a',
};

describe('migration 1162 — exact spawn-id filter', () => {
  it('filters by exact spawn id before limit and preserves ancestry', async () => {
    const rows = await sql<TreeRow[]>`
      SELECT id, spawn_id, parent_spawn_id, depth, root_spawn_id
        FROM harness_shared.tool_invocations_spawn_tree_filtered(
          p_harness_slug => ${args.harness},
          p_since => ${args.since},
          p_status => NULL,
          p_limit => 1,
          p_workspace_id => ${args.workspace},
          p_spawn_id => 'target-child'
        )
    `;

    // Without candidate-first filtering, row 3 would consume the limit and
    // the requested older target row would disappear from the result.
    expect(rows.map((row) => row.id)).toEqual(['6']);
    expect(rows[0]).toMatchObject({
      spawn_id: 'target-child',
      parent_spawn_id: 'target-root',
      depth: 1,
      root_spawn_id: 'target-root',
    });
  });

  it('keeps workspace, harness, and status predicates independent of spawnId', async () => {
    const rows = await sql<TreeRow[]>`
      SELECT id, spawn_id, parent_spawn_id, depth, root_spawn_id
        FROM harness_shared.tool_invocations_spawn_tree_filtered(
          p_harness_slug => ${args.harness},
          p_since => ${args.since},
          p_status => 'ok',
          p_limit => 200,
          p_workspace_id => ${args.workspace},
          p_spawn_id => 'target-child'
        )
       ORDER BY id
    `;
    expect(rows.map((row) => row.id)).toEqual(['2']);
  });

  it('keeps callers that omit spawnId source-compatible', async () => {
    const rows = await sql<{ id: string; spawn_id: string }[]>`
      SELECT id, spawn_id
        FROM harness_shared.tool_invocations_spawn_tree_filtered(
          p_harness_slug => ${args.harness},
          p_since => ${args.since},
          p_status => NULL,
          p_limit => 200,
          p_workspace_id => ${args.workspace}
        )
       ORDER BY id
    `;
    expect(rows.map((row) => row.id)).toEqual(['1', '2', '3', '6']);
  });

  it('is idempotent when reapplied', async () => {
    await expect(sql.unsafe(FILTER_MIGRATION_SQL)).resolves.not.toThrow();
    const rows = await sql<{ id: string }[]>`
      SELECT id
        FROM harness_shared.tool_invocations_spawn_tree_filtered(
          p_harness_slug => ${args.harness},
          p_since => ${args.since},
          p_limit => 1,
          p_workspace_id => ${args.workspace},
          p_spawn_id => 'target-child'
        )
    `;
    expect(rows.map((row) => row.id)).toEqual(['6']);
  });
});
