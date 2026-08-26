/**
 * atomic-checkout — the worker dispatch loop's FOR UPDATE SKIP LOCKED feature
 * claim, proven against a REAL Postgres (testcontainer; Docker required).
 * Covers claim ordering, the taken_by exclusion (two claims never collide),
 * lease-expiry recovery, scoped release, and the schema-name guard.
 *
 * Run: cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/atomic-checkout.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import {
  checkoutNextFeature,
  releaseExpired,
  releaseLock,
  setStatusAndRelease,
} from './atomic-checkout';

const SCHEMA = 'harness_test_checkout'; // matches /^harness_[a-z0-9_]+$/
const HS = 'papercup';

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'checkout',
    provision: async (url) => {
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
        await s.unsafe(`
          CREATE TABLE ${SCHEMA}.harness_features (
            harness_slug text NOT NULL,
            feature_id   text NOT NULL,
            title        text,
            status       text NOT NULL DEFAULT 'todo',
            attempts     int  NOT NULL DEFAULT 0,
            project_id   text,
            taken_by     text,
            taken_at     timestamptz,
            expires_at   timestamptz,
            created_ts   bigint NOT NULL DEFAULT 0,
            updated_ts   bigint NOT NULL DEFAULT 0,
            PRIMARY KEY (harness_slug, feature_id)
          )`);
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 8, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

async function seed(rows: Array<{ id: string; status?: string; createdTs: number; projectId?: string }>) {
  for (const r of rows) {
    await sql`
      INSERT INTO ${sql(`${SCHEMA}.harness_features`)} (harness_slug, feature_id, title, status, created_ts, project_id)
      VALUES (${HS}, ${r.id}, ${'title ' + r.id}, ${r.status ?? 'todo'}, ${r.createdTs}, ${r.projectId ?? null})`;
  }
}

beforeEach(async () => {
  await sql`TRUNCATE ${sql(`${SCHEMA}.harness_features`)}`;
});

describe('checkoutNextFeature', () => {
  it('claims the oldest available row, flips todo→in_progress, bumps attempts', async () => {
    await seed([{ id: 'F-002', createdTs: 2 }, { id: 'F-001', createdTs: 1 }]);
    const got = await checkoutNextFeature(sql, SCHEMA, HS, { workerId: 'w1' });
    expect(got).not.toBeNull();
    expect(got!.featureId).toBe('F-001'); // oldest created_ts
    expect(got!.status).toBe('in_progress');
    expect(got!.attempts).toBe(1);
    expect(got!.takenBy).toBe('w1');
    expect(got!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('never hands the same row to two workers (taken_by exclusion)', async () => {
    await seed([{ id: 'F-001', createdTs: 1 }, { id: 'F-002', createdTs: 2 }]);
    const a = await checkoutNextFeature(sql, SCHEMA, HS, { workerId: 'w1' });
    const b = await checkoutNextFeature(sql, SCHEMA, HS, { workerId: 'w2' });
    expect(new Set([a!.featureId, b!.featureId]).size).toBe(2);
    // Pool now empty.
    expect(await checkoutNextFeature(sql, SCHEMA, HS, { workerId: 'w3' })).toBeNull();
  });

  it('claims a failing row without changing its status', async () => {
    await seed([{ id: 'F-001', status: 'failing', createdTs: 1 }]);
    const got = await checkoutNextFeature(sql, SCHEMA, HS, { workerId: 'w1' });
    expect(got!.status).toBe('failing'); // CASE only flips todo
  });

  it('honors the statuses filter', async () => {
    await seed([{ id: 'F-001', status: 'failing', createdTs: 1 }]);
    expect(await checkoutNextFeature(sql, SCHEMA, HS, { workerId: 'w1', statuses: ['todo'] })).toBeNull();
  });

  it('honors the projectId filter', async () => {
    await seed([{ id: 'F-001', createdTs: 1, projectId: 'proj-a' }]);
    expect(await checkoutNextFeature(sql, SCHEMA, HS, { workerId: 'w1', projectId: 'proj-b' })).toBeNull();
    expect((await checkoutNextFeature(sql, SCHEMA, HS, { workerId: 'w1', projectId: 'proj-a' }))!.featureId).toBe('F-001');
  });
});

describe('releaseLock', () => {
  it('clears the lock for the matching worker only, leaving status untouched', async () => {
    await seed([{ id: 'F-001', createdTs: 1 }]);
    await checkoutNextFeature(sql, SCHEMA, HS, { workerId: 'w1' }); // todo → in_progress, locked
    expect(await releaseLock(sql, SCHEMA, HS, 'F-001', 'someone-else')).toBe(false);
    expect(await releaseLock(sql, SCHEMA, HS, 'F-001', 'w1')).toBe(true);
    // Lock cleared but status stays in_progress (releaseLock is "drop lock, no status change").
    const [row] = await sql`SELECT status, taken_by FROM ${sql(`${SCHEMA}.harness_features`)} WHERE feature_id = 'F-001'`;
    expect(row.taken_by).toBeNull();
    expect(row.status).toBe('in_progress');
    // So it is NOT re-claimed by the default todo/failing sweep...
    expect(await checkoutNextFeature(sql, SCHEMA, HS, { workerId: 'w2' })).toBeNull();
    // ...but IS claimable when in_progress is an allowed status.
    expect((await checkoutNextFeature(sql, SCHEMA, HS, { workerId: 'w2', statuses: ['in_progress'] }))!.featureId).toBe('F-001');
  });
});

describe('setStatusAndRelease', () => {
  it('sets a terminal status and clears the lock for the holder', async () => {
    await seed([{ id: 'F-001', createdTs: 1 }]);
    await checkoutNextFeature(sql, SCHEMA, HS, { workerId: 'w1' });
    expect(await setStatusAndRelease(sql, SCHEMA, HS, 'F-001', 'w2', 'passed')).toBe(false); // wrong worker
    expect(await setStatusAndRelease(sql, SCHEMA, HS, 'F-001', 'w1', 'passed')).toBe(true);
    const [row] = await sql`SELECT status, taken_by FROM ${sql(`${SCHEMA}.harness_features`)} WHERE feature_id = 'F-001'`;
    expect(row.status).toBe('passed');
    expect(row.taken_by).toBeNull();
  });
});

describe('releaseExpired', () => {
  it('recovers leases past expires_at (in_progress→todo) and reports the count', async () => {
    await seed([{ id: 'F-001', createdTs: 1 }]);
    await checkoutNextFeature(sql, SCHEMA, HS, { workerId: 'w1', leaseSec: 1 });
    // Force the lease into the past.
    await sql`UPDATE ${sql(`${SCHEMA}.harness_features`)} SET expires_at = now() - interval '1 minute' WHERE feature_id = 'F-001'`;
    expect(await releaseExpired(sql, SCHEMA)).toBe(1);
    const [row] = await sql`SELECT status, taken_by FROM ${sql(`${SCHEMA}.harness_features`)} WHERE feature_id = 'F-001'`;
    expect(row.status).toBe('todo');
    expect(row.taken_by).toBeNull();
    // A second sweep finds nothing.
    expect(await releaseExpired(sql, SCHEMA)).toBe(0);
  });
});

describe('schema-name guard', () => {
  it('rejects an invalid schema name (SQL-injection defense)', async () => {
    await expect(
      checkoutNextFeature(sql, 'public; DROP TABLE x', HS, { workerId: 'w1' }),
    ).rejects.toThrow(/invalid schema name/);
  });
});
