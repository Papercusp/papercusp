/**
 * write-skew — the D-002 correctness primitives (plan
 * locks-correctness-hardening-2026-06-04).
 *
 *   - withSerializableRetry: a SERIALIZABLE txn with 40001 retry, for multi-row
 *     read-set→decide→write invariants (the "last feature done → mark plan
 *     complete" shape). Proven by forcing a real write-skew and showing both
 *     txns eventually commit.
 *   - withProjectBudget: the materialize-onto-one-row fix (FOR UPDATE on the
 *     project row) for the hot budget path. Proven by showing two concurrent
 *     budget-gated spends cannot together exceed the cap.
 *
 * Each suite provisions its own FRESH testcontainer database (Docker required).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import {
  withSerializableRetry,
  SerializableRetryExhaustedError,
} from './with-serializable-retry';
import { withProjectBudget, BudgetExceededError } from './budget-enforcement';

const HARNESS_SCHEMA = 'harness_test_budget'; // matches /^harness_[a-z0-9_]+$/

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'wskew',
    provision: async (url) => {
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        // Minimal stand-ins for the production tables budget-enforcement reads.
        await s.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
        await s.unsafe(
          `CREATE TABLE harness_shared.projects (id text PRIMARY KEY, budget_cents bigint)`,
        );
        await s.unsafe(`CREATE SCHEMA IF NOT EXISTS ${HARNESS_SCHEMA}`);
        await s.unsafe(
          `CREATE TABLE ${HARNESS_SCHEMA}.harness_features (
             project_id text, expected_cost_cents bigint, status text NOT NULL DEFAULT 'todo'
           )`,
        );
        // A scratch table for the SERIALIZABLE write-skew demonstration.
        await s.unsafe(`CREATE TABLE skew_ledger (name text, val int)`);
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 10, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

describe('withSerializableRetry (D-002)', () => {
  it('retries on a real serialization_failure (40001) — both txns eventually commit', async () => {
    await sql`DELETE FROM skew_ledger`;
    let retried = 0;

    // Barrier: both transactions READ before either WRITES, forcing the rw
    // dependency cycle SSI aborts (the canonical write-skew). Only blocked on
    // each txn's FIRST attempt; the retry re-reads the now-committed state.
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const arriveAndWait = () => {
      if (++arrived >= 2) release();
      return gate;
    };

    const spender = (label: string) => {
      let attempt = 0;
      return withSerializableRetry(
        sql,
        async (tx) => {
          attempt++;
          const rows = await tx<Array<{ s: number }>>`
            SELECT COALESCE(SUM(val), 0)::int AS s FROM skew_ledger
          `;
          const s = rows[0].s;
          if (attempt === 1) await arriveAndWait();
          await tx`INSERT INTO skew_ledger (name, val) VALUES (${label}, ${s + 1})`;
        },
        { baseDelayMs: 1, onRetry: () => { retried++; } },
      );
    };

    await Promise.all([spender('a'), spender('b')]);

    expect(retried).toBeGreaterThanOrEqual(1); // a genuine 40001 was hit + retried
    const [{ c }] = await sql<Array<{ c: number }>>`SELECT count(*)::int AS c FROM skew_ledger`;
    expect(c).toBe(2); // neither was lost — both serialized successfully
  });

  it('propagates a non-serialization error immediately (no retry)', async () => {
    let retries = 0;
    await expect(
      withSerializableRetry(
        sql,
        async (tx) => {
          await tx`SELECT 1 FROM a_table_that_does_not_exist_zzz`;
        },
        { onRetry: () => { retries++; } },
      ),
    ).rejects.toThrow();
    expect(retries).toBe(0); // 42P01 is not retryable
  });

  it('throws SerializableRetryExhaustedError after exhausting retries', async () => {
    const conflict = Object.assign(new Error('synthetic conflict'), { code: '40001' });
    let calls = 0;
    await expect(
      withSerializableRetry(
        sql,
        async () => {
          calls++;
          throw conflict;
        },
        { maxRetries: 2, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(SerializableRetryExhaustedError);
    expect(calls).toBe(3); // initial attempt + 2 retries
  });
});

describe('withProjectBudget (D-002 — materialized invariant)', () => {
  const features = (s: Sql) => s(`${HARNESS_SCHEMA}.harness_features`);

  it('allows a spend within budget and runs it in the locked transaction', async () => {
    const pid = `proj-ok-${Date.now()}`;
    await sql`INSERT INTO harness_shared.projects (id, budget_cents) VALUES (${pid}, 1000)`;

    const out = await withProjectBudget(
      sql,
      { projectId: pid, proposedCostCents: 400, harnessSchemas: [HARNESS_SCHEMA] },
      (tx) =>
        tx`INSERT INTO ${features(tx)} (project_id, expected_cost_cents, status)
           VALUES (${pid}, 400, 'todo')`,
    );
    expect(out.budget.ok).toBe(true);

    const [{ total }] = await sql<Array<{ total: number }>>`
      SELECT COALESCE(SUM(expected_cost_cents), 0)::int AS total
        FROM ${features(sql)} WHERE project_id = ${pid}
    `;
    expect(total).toBe(400);
  });

  it('concurrent budget-gated spends cannot together exceed the cap (write-skew prevented)', async () => {
    const pid = `proj-race-${Date.now()}`;
    await sql`INSERT INTO harness_shared.projects (id, budget_cents) VALUES (${pid}, 100)`;

    // Each spend proposes 60: individually fits (committed 0 + 60 ≤ 100), but
    // two together (120) would exceed. The FOR UPDATE on the project row
    // serializes them so the second sees the first's committed cost.
    const spend = () =>
      withProjectBudget(
        sql,
        { projectId: pid, proposedCostCents: 60, harnessSchemas: [HARNESS_SCHEMA] },
        (tx) =>
          tx`INSERT INTO ${features(tx)} (project_id, expected_cost_cents, status)
             VALUES (${pid}, 60, 'todo')`,
      );

    const results = await Promise.allSettled([spend(), spend()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExceededError);

    // Exactly one feature row landed → committed total never exceeded 100.
    const [{ total }] = await sql<Array<{ total: number }>>`
      SELECT COALESCE(SUM(expected_cost_cents), 0)::int AS total
        FROM ${features(sql)} WHERE project_id = ${pid}
    `;
    expect(total).toBe(60);
  });
});
