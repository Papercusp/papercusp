/**
 * persistPlan atomicity (audit P-020) on REAL PG: the DELETE + chunk INSERTs
 * run in one transaction, so a failure mid-persist (here: a PK collision on a
 * duplicated chunk id — structurally the same as a crash between INSERTs)
 * leaves the PREVIOUS plan fully intact instead of half-replaced. Before the
 * fix the loop ran unwrapped: the old plan was already deleted and the first
 * inserts already visible, so resume-on-restart replayed a partial plan.
 *
 * Provisions a fresh testcontainer DB (Docker required) with a stand-in of
 * harness_shared.harness_chunk_plans matching the production PK + NOT NULL
 * shape (000-baseline.sql:935).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { persistPlan, readPlan, type ChunkPlanPgCtx } from './chunk-plan-pg.js';
import type { OrchestratorPg } from './invoke.js';

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'chunkplan',
    provision: async (url) => {
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
        await s.unsafe(`CREATE TABLE harness_shared.harness_chunk_plans (
          workspace_id text NOT NULL,
          harness_slug text NOT NULL,
          feature_id text NOT NULL,
          chunk_id text NOT NULL,
          chunk_index integer NOT NULL,
          files jsonb NOT NULL,
          description text NOT NULL,
          status text DEFAULT 'pending' NOT NULL,
          strikes integer DEFAULT 0 NOT NULL,
          last_error text,
          commit_sha text,
          created_ts bigint DEFAULT ((EXTRACT(epoch FROM now()) * (1000)::numeric))::bigint NOT NULL,
          updated_ts bigint DEFAULT ((EXTRACT(epoch FROM now()) * (1000)::numeric))::bigint NOT NULL,
          spawned_by_spawn_id text,
          CONSTRAINT harness_chunk_plans_pkey
            PRIMARY KEY (workspace_id, harness_slug, feature_id, chunk_id)
        )`);
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 5, onnotice: () => {} });
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

const ctx = (): ChunkPlanPgCtx => ({
  pg: sql as unknown as OrchestratorPg,
  workspaceId: 'ws-it',
  harnessSlug: 'chunkplan-it',
});

describe('persistPlan atomicity (P-020)', () => {
  it('replaces an existing plan wholesale', async () => {
    await persistPlan(ctx(), {
      featureId: 'F-A',
      chunks: [
        { id: 'F-A-1', files: ['a.ts'], description: 'v1 chunk 1' },
        { id: 'F-A-2', files: ['b.ts'], description: 'v1 chunk 2' },
      ],
    });
    await persistPlan(ctx(), {
      featureId: 'F-A',
      chunks: [{ id: 'F-A-10', files: ['c.ts'], description: 'v2 chunk 1' }],
    });
    const plan = await readPlan(ctx(), 'F-A');
    expect(plan.map((c) => c.chunkId)).toEqual(['F-A-10']);
    expect(plan[0].files).toEqual(['c.ts']);
  });

  it('a failure mid-persist rolls back — the previous plan survives intact', async () => {
    await persistPlan(ctx(), {
      featureId: 'F-B',
      chunks: [
        { id: 'F-B-1', files: ['a.ts'], description: 'v1 chunk 1' },
        { id: 'F-B-2', files: ['b.ts'], description: 'v1 chunk 2' },
      ],
    });
    // The third chunk duplicates the first's id → PK violation on the LAST
    // insert, after the DELETE and two inserts already executed in the txn.
    await expect(
      persistPlan(ctx(), {
        featureId: 'F-B',
        chunks: [
          { id: 'F-B-10', files: ['c.ts'], description: 'v2 chunk 1' },
          { id: 'F-B-11', files: ['d.ts'], description: 'v2 chunk 2' },
          { id: 'F-B-10', files: ['e.ts'], description: 'v2 dup — boom' },
        ],
      }),
    ).rejects.toThrow();
    const plan = await readPlan(ctx(), 'F-B');
    expect(plan.map((c) => c.chunkId)).toEqual(['F-B-1', 'F-B-2']);
    expect(plan.map((c) => c.description)).toEqual(['v1 chunk 1', 'v1 chunk 2']);
  });
});
