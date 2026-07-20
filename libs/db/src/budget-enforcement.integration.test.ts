/**
 * budget-enforcement — hard-stop budget checks at proposal-accept, proven
 * against a REAL Postgres (testcontainer; Docker required).
 *
 * Complements write-skew.integration.test.ts (which proves withProjectBudget's
 * happy path + a single-pool race for D-002); this file covers the full
 * arithmetic contract (exact committedCents/remainingCents/wouldExceedBy),
 * the exactly-at-cap boundary (strict `>` — spending TO the cap is allowed),
 * rejection without mutation, status/schema/project scoping, the no-cap
 * (NULL budget) early-out, schema-name validation, and a two-connection
 * concurrent accept where the project-row lock must let exactly one win.
 *
 * Run: npx vitest run --config vitest.integration.config.ts src/budget-enforcement.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import {
  checkProjectBudget,
  assertProjectBudget,
  withProjectBudget,
  BudgetExceededError,
  type BudgetCheckResult,
} from './budget-enforcement';

// Both match the module's /^harness_[a-z0-9_]+$/ schema-name contract.
const SCHEMA_A = 'harness_test_a';
const SCHEMA_B = 'harness_test_b';

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'budget',
    provision: async (url) => {
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        // Minimal stand-ins for the production tables budget-enforcement reads.
        await s.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
        await s.unsafe(
          `CREATE TABLE harness_shared.projects (id text PRIMARY KEY, budget_cents bigint)`,
        );
        for (const schema of [SCHEMA_A, SCHEMA_B]) {
          await s.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
          await s.unsafe(
            `CREATE TABLE ${schema}.harness_features (
               project_id text, expected_cost_cents bigint, status text NOT NULL DEFAULT 'todo'
             )`,
          );
        }
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

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.projects`;
  await sql.unsafe(`TRUNCATE ${SCHEMA_A}.harness_features, ${SCHEMA_B}.harness_features`);
});

const features = (s: Sql, schema: string = SCHEMA_A) => s(`${schema}.harness_features`);

const addProject = (id: string, budgetCents: number | null) =>
  sql`INSERT INTO harness_shared.projects (id, budget_cents) VALUES (${id}, ${budgetCents})`;

const addFeature = (projectId: string, cents: number, status = 'todo', schema = SCHEMA_A) =>
  sql`INSERT INTO ${features(sql, schema)} (project_id, expected_cost_cents, status)
      VALUES (${projectId}, ${cents}, ${status})`;

const committedTotal = async (projectId: string, schema = SCHEMA_A): Promise<number> => {
  const [{ total }] = await sql<Array<{ total: number }>>`
    SELECT COALESCE(SUM(expected_cost_cents), 0)::int AS total
      FROM ${features(sql, schema)} WHERE project_id = ${projectId}
  `;
  return total;
};

/** checkProjectBudget's contract requires a surrounding transaction (FOR UPDATE). */
const check = (projectId: string, cents: number, schemas: string[] = [SCHEMA_A]) =>
  sql.begin((tx) =>
    checkProjectBudget(tx as unknown as Sql, projectId, cents, schemas),
  ) as Promise<BudgetCheckResult>;

describe('checkProjectBudget', () => {
  it('within budget — ok with exact committed/remaining math', async () => {
    await addProject('p-within', 1000);
    await addFeature('p-within', 300);

    const r = await check('p-within', 500);
    expect(r).toEqual({
      ok: true,
      projectId: 'p-within',
      budgetCents: 1000,
      committedCents: 300,
      proposedCents: 500,
      remainingCents: 700,
    });
  });

  it('over budget — ok=false with exact remainingCents + wouldExceedBy', async () => {
    await addProject('p-over', 1000);
    await addFeature('p-over', 300);

    const r = await check('p-over', 800);
    expect(r).toEqual({
      ok: false,
      projectId: 'p-over',
      budgetCents: 1000,
      committedCents: 300,
      proposedCents: 800,
      remainingCents: 700,
      wouldExceedBy: 100,
    });
  });

  it('boundary — landing EXACTLY at the cap is allowed (strict > comparison)', async () => {
    await addProject('p-cap', 1000);
    await addFeature('p-cap', 300);

    // committed (300) + proposed (700) === budget (1000) → NOT an excess.
    const atCap = await check('p-cap', 700);
    expect(atCap.ok).toBe(true);
    expect(atCap.remainingCents).toBe(700);
    expect(atCap.wouldExceedBy).toBeUndefined();

    // …but one cent past the cap is rejected.
    const oneOver = await check('p-cap', 701);
    expect(oneOver.ok).toBe(false);
    expect(oneOver.wouldExceedBy).toBe(1);
  });

  it('no budget cap (NULL) — ok with remainingCents=null and no committed scan', async () => {
    await addProject('p-nocap', null);
    await addFeature('p-nocap', 12345); // present but never summed: the no-cap path early-outs

    const r = await check('p-nocap', 50);
    expect(r).toEqual({
      ok: true,
      projectId: 'p-nocap',
      budgetCents: null,
      committedCents: 0,
      proposedCents: 50,
      remainingCents: null,
    });
  });

  it('excludes cancelled/rejected features from the committed sum (other statuses count)', async () => {
    await addProject('p-status', 1000);
    await addFeature('p-status', 300, 'todo');
    await addFeature('p-status', 100, 'done');
    await addFeature('p-status', 400, 'cancelled');
    await addFeature('p-status', 500, 'rejected');

    const r = await check('p-status', 1);
    expect(r.committedCents).toBe(400); // 300 todo + 100 done
    expect(r.remainingCents).toBe(600);
  });

  it('sums committed costs across ALL supplied harness schemas', async () => {
    await addProject('p-multi', 1000);
    await addFeature('p-multi', 200, 'todo', SCHEMA_A);
    await addFeature('p-multi', 250, 'todo', SCHEMA_B);

    const r = await check('p-multi', 100, [SCHEMA_A, SCHEMA_B]);
    expect(r.committedCents).toBe(450);
    expect(r.remainingCents).toBe(550);
  });

  it("scopes committed costs to the project — another project's spend never counts", async () => {
    await addProject('p-mine', 500);
    await addProject('p-other', 500);
    await addFeature('p-other', 450);

    const r = await check('p-mine', 100);
    expect(r.committedCents).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('throws for an unknown project', async () => {
    await expect(check('p-missing', 10)).rejects.toThrow(/project p-missing not found/);
  });

  it('rejects a schema name outside the harness_* contract before touching anything', async () => {
    await addProject('p-schema', 1000);
    await expect(check('p-schema', 10, ['public'])).rejects.toThrow(/invalid schema name/);
    await expect(
      check('p-schema', 10, ['harness_x; DROP TABLE harness_shared.projects']),
    ).rejects.toThrow(/invalid schema name/);
  });
});

describe('assertProjectBudget', () => {
  it('returns the check result when within budget', async () => {
    await addProject('p-assert-ok', 1000);
    const r = (await sql.begin((tx) =>
      assertProjectBudget(tx as unknown as Sql, 'p-assert-ok', 400, [SCHEMA_A]),
    )) as BudgetCheckResult;
    expect(r.ok).toBe(true);
    expect(r.remainingCents).toBe(1000);
  });

  it('throws BudgetExceededError carrying the exact detail when over budget', async () => {
    await addProject('p-assert-no', 1000);
    await addFeature('p-assert-no', 950);

    const err = await sql
      .begin((tx) => assertProjectBudget(tx as unknown as Sql, 'p-assert-no', 100, [SCHEMA_A]))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    const detail = (err as BudgetExceededError).detail;
    expect(detail.committedCents).toBe(950);
    expect(detail.remainingCents).toBe(50);
    expect(detail.wouldExceedBy).toBe(50);
  });
});

describe('withProjectBudget', () => {
  it('accept within budget — spend runs in the locked tx and is accounted exactly', async () => {
    await addProject('p-spend', 1000);
    await addFeature('p-spend', 300);

    const out = await withProjectBudget(
      sql,
      { projectId: 'p-spend', proposedCostCents: 400, harnessSchemas: [SCHEMA_A] },
      async (tx) => {
        await tx`INSERT INTO ${features(tx)} (project_id, expected_cost_cents, status)
                 VALUES ('p-spend', 400, 'todo')`;
        return 'spent';
      },
    );
    expect(out.result).toBe('spent'); // spend's return value passes through
    expect(out.budget.ok).toBe(true);
    expect(out.budget.committedCents).toBe(300); // pre-spend snapshot
    expect(out.budget.remainingCents).toBe(700);

    // The spend landed, and a fresh check sees it as committed.
    expect(await committedTotal('p-spend')).toBe(700);
    const after = await check('p-spend', 0);
    expect(after.committedCents).toBe(700);
    expect(after.remainingCents).toBe(300);
  });

  it('rejected accept throws BEFORE spend runs and mutates nothing', async () => {
    await addProject('p-reject', 100);
    await addFeature('p-reject', 80);

    let spendCalled = false;
    await expect(
      withProjectBudget(
        sql,
        { projectId: 'p-reject', proposedCostCents: 30, harnessSchemas: [SCHEMA_A] },
        async (tx) => {
          spendCalled = true;
          await tx`INSERT INTO ${features(tx)} (project_id, expected_cost_cents, status)
                   VALUES ('p-reject', 30, 'todo')`;
        },
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(spendCalled).toBe(false);
    expect(await committedTotal('p-reject')).toBe(80); // unchanged
  });

  it('boundary — spending exactly to the cap succeeds; the next cent is rejected', async () => {
    await addProject('p-edge', 100);

    const out = await withProjectBudget(
      sql,
      { projectId: 'p-edge', proposedCostCents: 100, harnessSchemas: [SCHEMA_A] },
      (tx) =>
        tx`INSERT INTO ${features(tx)} (project_id, expected_cost_cents, status)
           VALUES ('p-edge', 100, 'todo')`,
    );
    expect(out.budget.ok).toBe(true);
    expect(await committedTotal('p-edge')).toBe(100);

    const err = await withProjectBudget(
      sql,
      { projectId: 'p-edge', proposedCostCents: 1, harnessSchemas: [SCHEMA_A] },
      async () => {},
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).detail.wouldExceedBy).toBe(1);
    expect((err as BudgetExceededError).detail.remainingCents).toBe(0);
  });

  it('a failing spend rolls back atomically — no partial write escapes', async () => {
    await addProject('p-atomic', 1000);

    await expect(
      withProjectBudget(
        sql,
        { projectId: 'p-atomic', proposedCostCents: 100, harnessSchemas: [SCHEMA_A] },
        async (tx) => {
          await tx`INSERT INTO ${features(tx)} (project_id, expected_cost_cents, status)
                   VALUES ('p-atomic', 100, 'todo')`;
          throw new Error('spend exploded');
        },
      ),
    ).rejects.toThrow('spend exploded');

    expect(await committedTotal('p-atomic')).toBe(0); // INSERT rolled back with the tx
  });

  it('CONCURRENCY — two simultaneous accepts on SEPARATE connections: exactly one wins, cap never exceeded', async () => {
    await addProject('p-race', 100);

    // Two physically separate connections (not just two pool checkouts), so
    // the only thing serializing them is the FOR UPDATE on the project row.
    // Each proposes 60: individually fine, together 120 > 100.
    const connA = postgres(db.url, { max: 1, onnotice: () => {} });
    const connB = postgres(db.url, { max: 1, onnotice: () => {} });
    try {
      const spend = (conn: Sql) =>
        withProjectBudget(
          conn,
          { projectId: 'p-race', proposedCostCents: 60, harnessSchemas: [SCHEMA_A] },
          (tx) =>
            tx`INSERT INTO ${features(tx)} (project_id, expected_cost_cents, status)
               VALUES ('p-race', 60, 'todo')`,
        );

      const results = await Promise.allSettled([spend(connA), spend(connB)]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExceededError);

      // Exactly one 60¢ feature landed → total committed (60) ≤ cap (100).
      expect(await committedTotal('p-race')).toBe(60);
    } finally {
      await connA.end({ timeout: 5 });
      await connB.end({ timeout: 5 });
    }
  });
});
