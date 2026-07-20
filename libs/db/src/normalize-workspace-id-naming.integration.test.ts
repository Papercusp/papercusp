/**
 * normalize-workspace-id-naming.integration.test.ts — migration 399 adds a
 * `workspace_id` GENERATED mirror of the legacy `workspace` column on the three
 * telemetry tables (agent_actions, agent_queries, voice_utterances) as the EXPAND step
 * of a zero-downtime rename (data-scoping-audit-2026-06-22 P-009; D-006 fresh-DB test).
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts \
 *     src/normalize-workspace-id-naming.integration.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, '..', 'sql');
const MIGRATION_399 = readFileSync(
  join(SQL_DIR, '399-normalize-workspace-id-naming-telemetry.sql'),
  'utf8',
);

// Minimal shapes of the three tables 399 alters — each carries the legacy `workspace` col.
const BASE_DDL = `
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE IF NOT EXISTS harness_shared.agent_actions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, agent text NOT NULL,
    command_id text NOT NULL, args jsonb NOT NULL DEFAULT '{}'::jsonb, status text NOT NULL DEFAULT 'ok',
    workspace text);
  CREATE TABLE IF NOT EXISTS harness_shared.agent_queries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, agent text NOT NULL,
    query_id text NOT NULL, workspace text);
  CREATE TABLE IF NOT EXISTS harness_shared.voice_utterances (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, source text NOT NULL,
    name_used boolean NOT NULL DEFAULT false, had_backstory boolean NOT NULL DEFAULT false,
    workspace text);
`;

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BASE_DDL);
    // Seed rows BEFORE the migration → the generated mirror must auto-backfill them.
    await client.unsafe(`
      INSERT INTO harness_shared.agent_actions (agent, command_id, workspace) VALUES
        ('a1','plans:get','ws-1'), ('a2','plans:get', NULL);
      INSERT INTO harness_shared.agent_queries (agent, query_id, workspace) VALUES ('a1','q1','ws-7');
      INSERT INTO harness_shared.voice_utterances (source, workspace) VALUES ('say','ws-9');
    `);
    await client.unsafe(MIGRATION_399);
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'wsnaming', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

const TABLES = ['agent_actions', 'agent_queries', 'voice_utterances'] as const;

describe('migration 399: workspace → workspace_id naming normalization (expand)', () => {
  it('adds a GENERATED workspace_id column on all three tables', async () => {
    const cols = (await sql`
      SELECT table_name, is_generated FROM information_schema.columns
      WHERE table_schema = 'harness_shared' AND column_name = 'workspace_id'
        AND table_name IN ('agent_actions','agent_queries','voice_utterances')
      ORDER BY table_name`) as unknown as Array<{ table_name: string; is_generated: string }>;
    expect(cols.map((c) => c.table_name)).toEqual([...TABLES].sort());
    expect(cols.every((c) => c.is_generated === 'ALWAYS')).toBe(true);
  });

  it('mirrors workspace into workspace_id for pre-existing rows (incl NULL → NULL)', async () => {
    const aa = (await sql`
      SELECT workspace, workspace_id FROM harness_shared.agent_actions ORDER BY id`) as unknown as Array<{
      workspace: string | null;
      workspace_id: string | null;
    }>;
    expect(aa).toEqual([
      { workspace: 'ws-1', workspace_id: 'ws-1' },
      { workspace: null, workspace_id: null },
    ]);
    const [aq] = (await sql`SELECT workspace_id FROM harness_shared.agent_queries`) as unknown as Array<{ workspace_id: string }>;
    expect(aq.workspace_id).toBe('ws-7');
    const [vu] = (await sql`SELECT workspace_id FROM harness_shared.voice_utterances`) as unknown as Array<{ workspace_id: string }>;
    expect(vu.workspace_id).toBe('ws-9');
  });

  it('keeps workspace as the source of truth: a new write to workspace flows to workspace_id', async () => {
    await sql`INSERT INTO harness_shared.agent_actions (agent, command_id, workspace) VALUES ('a3','x','ws-new')`;
    const [row] = (await sql`SELECT workspace_id FROM harness_shared.agent_actions WHERE agent = 'a3'`) as unknown as Array<{ workspace_id: string }>;
    expect(row.workspace_id).toBe('ws-new');
  });

  it('rejects a direct write to the generated workspace_id', async () => {
    await expect(
      sql`INSERT INTO harness_shared.agent_queries (agent, query_id, workspace_id) VALUES ('a9','q9','illegal')`,
    ).rejects.toThrow();
  });

  it('is idempotent — re-applying 399 is a clean no-op', async () => {
    await expect(sql.unsafe(MIGRATION_399)).resolves.toBeDefined();
  });
});
