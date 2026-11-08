/**
 * goal-pots.integration.test.ts — the goal ↔ pot edge and, above all, the
 * recurrence guard for D-021: GOAL METERS DO NOT SUM.
 *
 * Why this is an INTEGRATION test rather than a unit test with a fake `sql`:
 * every property worth protecting here is a property of the SQL itself — a
 * partial UNIQUE index, an `ON CONFLICT` targeting that index's predicate, and
 * a `DISTINCT` inside a CTE. A stubbed tagged-template can assert only that we
 * *sent* certain strings, which is precisely the assertion that stays green
 * while the semantics break. The schema comes from the real migration runner,
 * so there is no hand-rolled `CREATE TABLE` to drift out of sync with
 * migrations 765 (the original table) and 782 (its rename to `goal_pots`).
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/goal-pots.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import {
  createFreshTestDb,
  TESTCONTAINER_START_LOCK_TIMEOUT_MS,
  type MigratedTestDb,
} from '@papercusp/test-config/pg';
import {
  goalSpend,
  goalsForPot,
  linkPot,
  portfolioSpend,
  potsForGoal,
  setMainOwner,
  unlinkPot,
} from './goal-pots';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, '..', 'sql');
const RUNNER = join(here, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');

const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (o: { client: Sql; sqlDir: string }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    if (appliedCount !== totalKnown) {
      throw new Error(`goal-pots provision: applied ${appliedCount}/${totalKnown} (expected zero skips)`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

const WS = 'test-ws';
let db: MigratedTestDb;
let sql: Sql;

// This suite replays the full migration chain, whose bulk path ends with a
// durable CHECKPOINT. Keep Vitest's outer hook deadline above the shared
// Testcontainers startup-lock budget: equal 180s deadlines let Vitest cancel
// before the migration runner can surface the actionable inner stage (the
// checkpoint/fsync wait or a real lock-holder diagnostic) — EI-21864623595580605.
const GOAL_POTS_SETUP_TIMEOUT_MS = TESTCONTAINER_START_LOCK_TIMEOUT_MS + 60_000;

async function makeGoal(id: string, title = id): Promise<void> {
  await sql`
    INSERT INTO harness_shared.goals (id, install_slug, workspace_id, title, status)
    VALUES (${id}, 'papercusp', ${WS}, ${title}, 'active')
  `;
}

/** One usage sample worth `cost` dollars, attributed to `harnessSlug`. */
async function spend(harnessSlug: string, cost: number | null, ts = Date.now()): Promise<void> {
  await sql`
    INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, ts, bucket_key, provider, model_class, source, cost_usd, harness_slug)
    VALUES (${WS}, ${ts}, 'b', 'anthropic', 'sonnet', 'test', ${cost}, ${harnessSlug})
  `;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'goalpots', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`SELECT set_config('app.workspace_id', '${WS}', false)`);
  await sql.unsafe(`SELECT set_config('papercusp.workspace_id', '${WS}', false)`);
}, GOAL_POTS_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.goal_pots`;
  await sql`DELETE FROM harness_shared.agent_usage_samples`;
  await sql`DELETE FROM harness_shared.goals`;
});

describe('D-021 — goal meters DO NOT SUM', () => {
  it('keeps setup diagnostics outside the startup-lock deadline', () => {
    expect(GOAL_POTS_SETUP_TIMEOUT_MS).toBeGreaterThan(TESTCONTAINER_START_LOCK_TIMEOUT_MS);
  });

  it('never charges a goal for pot spend from before the goal existed', async () => {
    const goalCreatedAt = Date.now();
    await makeGoal('goal-a');
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'existing-pot' });
    await spend('existing-pot', 1000, goalCreatedAt - 60_000);
    await spend('existing-pot', 4, goalCreatedAt + 60_000);

    const rollup = await goalSpend(sql, { workspaceId: WS, goalId: 'goal-a' });
    expect(rollup.costUsd).toBeCloseTo(4, 6);
    expect(rollup.samples).toBe(1);
  });

  it('never charges a goal for pot spend from before that pot was linked', async () => {
    await makeGoal('goal-a');
    const link = await linkPot(sql, {
      workspaceId: WS,
      goalId: 'goal-a',
      harnessSlug: 'existing-pot',
    });
    const linkedAt = Date.parse(link.addedAt);
    const goalCreatedAt = linkedAt - 120_000;
    await sql`
      UPDATE harness_shared.goals
         SET created_at = to_timestamp(${goalCreatedAt}::double precision / 1000)
       WHERE workspace_id = ${WS}
         AND id = 'goal-a'
    `;

    // Both samples are inside the goal lifetime. Only the second is inside
    // this pot's contribution lifetime, and its exact-boundary timestamp must
    // remain included at the usage stream's integer-millisecond precision.
    await spend('existing-pot', 1000, linkedAt - 60_000);
    await spend('existing-pot', 4, linkedAt);

    const rollup = await goalSpend(sql, { workspaceId: WS, goalId: 'goal-a' });
    expect(rollup.costUsd).toBeCloseTo(4, 6);
    expect(rollup.samples).toBe(1);
  });

  it('lets an explicit sinceMs narrow, but never widen, the goal-lifetime window', async () => {
    const goalCreatedAt = Date.now();
    await makeGoal('goal-a');
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'existing-pot' });
    await spend('existing-pot', 1000, goalCreatedAt - 60_000);
    await spend('existing-pot', 4, goalCreatedAt + 30_000);
    await spend('existing-pot', 2, goalCreatedAt + 90_000);

    const widened = await goalSpend(sql, {
      workspaceId: WS,
      goalId: 'goal-a',
      sinceMs: goalCreatedAt - 120_000,
    });
    expect(widened.costUsd).toBeCloseTo(6, 6);

    const narrowed = await goalSpend(sql, {
      workspaceId: WS,
      goalId: 'goal-a',
      sinceMs: goalCreatedAt + 60_000,
    });
    expect(narrowed.costUsd).toBeCloseTo(2, 6);
  });

  /**
   * THE guard. Two goals share one pot; the pot cost $10.
   *
   * Each goal correctly reports the full $10 — from that goal's point of view
   * the shared work IS what pursuing it costs. The portfolio total is
   * therefore NOT $20. If someone "simplifies" portfolioSpend into a sum of
   * goalSpend calls, this fails; nothing else in the system would notice,
   * because both inputs are individually correct and the wrong answer is a
   * plausible number.
   */
  it('counts a SHARED pot in full per goal, but exactly once across the portfolio', async () => {
    await makeGoal('goal-a');
    await makeGoal('goal-b');
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'payments-lib' });
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-b', harnessSlug: 'payments-lib' });
    await spend('payments-lib', 10);

    const a = await goalSpend(sql, { workspaceId: WS, goalId: 'goal-a' });
    const b = await goalSpend(sql, { workspaceId: WS, goalId: 'goal-b' });
    expect(a.costUsd).toBeCloseTo(10, 6);
    expect(b.costUsd).toBeCloseTo(10, 6);

    const portfolio = await portfolioSpend(sql, { workspaceId: WS, goalIds: ['goal-a', 'goal-b'] });
    expect(portfolio.costUsd).toBeCloseTo(10, 6); // NOT 20
    expect(portfolio.pots).toBe(1);
    // Stated as the inequality the invariant actually is, so a reader of a
    // failure sees the claim rather than two bare numbers.
    expect(portfolio.costUsd).not.toBeCloseTo(a.costUsd + b.costUsd, 6);
  });

  it('marks a rollup unmeasured when any linked sample lacks a cost', async () => {
    await makeGoal('goal-a');
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'pot-a' });
    await spend('pot-a', 3);
    await spend('pot-a', null);

    const spendRollup = await goalSpend(sql, { workspaceId: WS, goalId: 'goal-a' });
    expect(spendRollup).toMatchObject({
      costUsd: 3,
      samples: 2,
      pricedSamples: 1,
      unpricedSamples: 1,
      measured: false,
    });
  });

  it('still adds up when the goals share nothing — the DISTINCT must not under-count', async () => {
    await makeGoal('goal-a');
    await makeGoal('goal-b');
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'pot-a' });
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-b', harnessSlug: 'pot-b' });
    await spend('pot-a', 3);
    await spend('pot-b', 4);

    const portfolio = await portfolioSpend(sql, { workspaceId: WS, goalIds: ['goal-a', 'goal-b'] });
    expect(portfolio.costUsd).toBeCloseTo(7, 6);
    expect(portfolio.pots).toBe(2);
  });

  it('excludes an unlinked pot from the goal it left', async () => {
    await makeGoal('goal-a');
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'pot-a' });
    await spend('pot-a', 5);
    expect((await goalSpend(sql, { workspaceId: WS, goalId: 'goal-a' })).costUsd).toBeCloseTo(5, 6);

    await unlinkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'pot-a' });
    expect((await goalSpend(sql, { workspaceId: WS, goalId: 'goal-a' })).costUsd).toBeCloseTo(0, 6);
  });

  it('totals every goal in the workspace when no ids are named', async () => {
    await makeGoal('goal-a');
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'pot-a' });
    await spend('pot-a', 2);
    await spend('unlinked-pot', 99); // never attached to a goal
    const portfolio = await portfolioSpend(sql, { workspaceId: WS });
    expect(portfolio.costUsd).toBeCloseTo(2, 6);
  });

  it('summarizes shared, unpriced and credited pots with the detailed reader boundaries', async () => {
    await makeGoal('goal-a');
    await makeGoal('goal-b');
    for (const harnessSlug of ['shared', 'empty', 'unpriced', 'pre-epoch']) {
      await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug });
    }
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-b', harnessSlug: 'shared' });
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-b', harnessSlug: 'credit' });
    await spend('shared', 10, 1);
    await spend('unpriced', null, 2);
    await spend('credit', -2, 3);
    await spend('pre-epoch', 7, -1);
    await spend('unlinked', 99, 4);
    await sql`
      INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, ts, bucket_key, provider, model_class, source, cost_usd, harness_slug)
      VALUES ('other-workspace', 1, 'b', 'anthropic', 'sonnet', 'test', 1000, 'shared')
    `;
    const scope = { workspaceId: WS, goalIds: ['goal-a', 'goal-b'] };
    const detailed = await portfolioSpend(sql, scope);
    expect(detailed).toMatchObject({ costUsd: 8, pots: 3 });
    expect(detailed.byPot.find(p => p.harnessSlug === 'unpriced')?.samples).toBe(1);
    expect(await portfolioSpend(sql, { ...scope, summaryOnly: true })).toEqual({ costUsd: 8, pots: 3 });
    expect(await portfolioSpend(sql, { workspaceId: WS, summaryOnly: true })).toEqual({ costUsd: 8, pots: 3 });
    expect(await portfolioSpend(sql, { workspaceId: WS, goalIds: [], summaryOnly: true }))
      .toEqual({ costUsd: 0, pots: 0 });
    expect(await portfolioSpend(sql, { workspaceId: WS, goalIds: ['goal-a'], summaryOnly: true }))
      .toEqual({ costUsd: 10, pots: 2 });
    expect(await portfolioSpend(sql, { ...scope, sinceMs: 2 })).toMatchObject({ costUsd: -2, pots: 2 });
    await unlinkPot(sql, { workspaceId: WS, goalId: 'goal-b', harnessSlug: 'credit' });
    expect(await portfolioSpend(sql, { ...scope, summaryOnly: true })).toEqual({ costUsd: 10, pots: 2 });
  });

  it('keeps portfolio summaries exact after cost, harness, timestamp and deletion changes', async () => {
    await makeGoal('goal-a');
    for (const harnessSlug of ['original', 'moved', 'pre-epoch']) {
      await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug });
    }
    await spend('original', 5, 1);
    await spend('pre-epoch', 7, -1);
    const summary = () => portfolioSpend(sql, { workspaceId: WS, summaryOnly: true });
    expect(await summary()).toEqual({ costUsd: 5, pots: 1 });
    await sql`UPDATE harness_shared.agent_usage_samples SET cost_usd = 8
      WHERE workspace_id = ${WS} AND harness_slug = 'original'`;
    expect(await summary()).toEqual({ costUsd: 8, pots: 1 });
    await sql`UPDATE harness_shared.agent_usage_samples SET harness_slug = 'moved'
      WHERE workspace_id = ${WS} AND harness_slug = 'original'`;
    expect(await summary()).toEqual({ costUsd: 8, pots: 1 });
    await sql`UPDATE harness_shared.agent_usage_samples SET ts = 2
      WHERE workspace_id = ${WS} AND harness_slug = 'pre-epoch'`;
    expect(await summary()).toEqual({ costUsd: 15, pots: 2 });
    await sql`DELETE FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS}`;
    // The trigger retains zero-total rows; they are not pots with samples.
    expect(await summary()).toEqual({ costUsd: 0, pots: 0 });
  });
});

describe('one main owner per pot — enforced by the schema, not by convention', () => {
  it('demotes the incumbent owner instead of violating the partial unique index', async () => {
    await makeGoal('goal-a');
    await makeGoal('goal-b');
    await setMainOwner(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'shared' });
    await setMainOwner(sql, { workspaceId: WS, goalId: 'goal-b', harnessSlug: 'shared' });

    const links = await goalsForPot(sql, { workspaceId: WS, harnessSlug: 'shared' });
    expect(links.filter((l) => l.role === 'owner').map((l) => l.goalId)).toEqual(['goal-b']);
    // The demoted goal keeps a real, secondary claim — losing it would drop
    // the pot off goal-a's page entirely.
    expect(links.find((l) => l.goalId === 'goal-a')?.role).toBe('contributing');
    expect(links).toHaveLength(2);
  });

  it('re-linking an existing pair updates it rather than erroring', async () => {
    await makeGoal('goal-a');
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'p', note: 'first' });
    const again = await linkPot(sql, {
      workspaceId: WS,
      goalId: 'goal-a',
      harnessSlug: 'p',
      role: 'owner',
    });
    expect(again.role).toBe('owner');
    expect(again.note).toBe('first'); // an omitted note must not erase the recorded one
    expect(await potsForGoal(sql, { workspaceId: WS, goalId: 'goal-a' })).toHaveLength(1);
  });

  it('lists the main owner first', async () => {
    await makeGoal('goal-a');
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'contrib' });
    await setMainOwner(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'main' });
    const pots = await potsForGoal(sql, { workspaceId: WS, goalId: 'goal-a' });
    expect(pots.map((p) => p.harnessSlug)).toEqual(['main', 'contrib']);
  });
});

describe('unlink is a tombstone, not a DELETE', () => {
  it('keeps the history row and allows a later re-link', async () => {
    await makeGoal('goal-a');
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'p' });
    expect(await unlinkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'p' })).toBe(true);

    const [{ count }] = await sql<Array<{ count: string }>>`
      SELECT COUNT(*) AS count FROM harness_shared.goal_pots WHERE removed_at IS NOT NULL
    `;
    expect(Number(count)).toBe(1);
    expect(await potsForGoal(sql, { workspaceId: WS, goalId: 'goal-a' })).toHaveLength(0);

    // The live-pair uniqueness index is partial on removed_at IS NULL, so this
    // must be legal — a pot can leave a goal and come back.
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'p' });
    expect(await potsForGoal(sql, { workspaceId: WS, goalId: 'goal-a' })).toHaveLength(1);
  });

  it('reports false when there was no live link to remove', async () => {
    await makeGoal('goal-a');
    expect(await unlinkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'nope' })).toBe(false);
  });
});

describe('workspace scoping', () => {
  it('never counts another workspace\'s spend against this goal', async () => {
    await makeGoal('goal-a');
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'p' });
    await spend('p', 4);
    await sql`
      INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, ts, bucket_key, provider, model_class, source, cost_usd, harness_slug)
      VALUES ('other-ws', ${Date.now()}, 'b', 'anthropic', 'sonnet', 'test', 1000, 'p')
    `;
    expect((await goalSpend(sql, { workspaceId: WS, goalId: 'goal-a' })).costUsd).toBeCloseTo(4, 6);
  });
});

/**
 * Performance contract (papercusp-performance-audit-2026-10-12 P-007, migration 1486).
 *
 * `goals.list` re-resolves on every agent_usage_samples sweep tick and every work-item
 * write, and each resolve totals ALL of a linked pot's samples. Measured live before
 * 1486: Index Scan, 1.87 M rows, 1.85 M shared buffers, 1,250 ms per call — every index
 * tuple paid a heap fetch just to read cost_usd. The fix is a covering index, so the
 * property worth pinning is that BOTH spend reads stay index-only: a new column read
 * from `s` (or an index that stops covering cost_usd) silently reintroduces the heap
 * fetch, and nothing else would notice until the next audit.
 *
 * The SQL under test is captured from the real functions through postgres.js `debug`,
 * never re-typed here. Seq/bitmap scans are disabled so the planner must choose between
 * the two index paths; after VACUUM the only reason to pick a heap-fetching Index Scan
 * is that the index does not cover the query.
 */
describe('spend reads stay index-only (migration 1486)', () => {
  type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };

  function usageScans(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
    if (node['Relation Name'] === 'agent_usage_samples') out.push(node);
    for (const child of node.Plans ?? []) usageScans(child, out);
    return out;
  }

  /** Run `read` against a capturing client and return the agent_usage_samples statement it sent. */
  async function captureUsageQuery(read: (client: Sql) => Promise<unknown>): Promise<{ query: string; params: unknown[] }> {
    const captured: Array<{ query: string; params: unknown[] }> = [];
    const client = postgres(db.url, {
      max: 1,
      onnotice: () => {},
      debug: (_conn: number, query: string, params: unknown[]) => {
        if (query.includes('agent_usage_samples')) captured.push({ query, params: [...params] });
      },
    });
    try {
      await read(client);
    } finally {
      await client.end({ timeout: 5 });
    }
    expect(captured).toHaveLength(1);
    return captured[0]!;
  }

  async function usageScanNodes(captured: { query: string; params: unknown[] }): Promise<PlanNode[]> {
    await sql.unsafe('VACUUM (ANALYZE) harness_shared.agent_usage_samples');
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      await tx.unsafe('SET LOCAL enable_bitmapscan = off');
      return tx.unsafe(`EXPLAIN (FORMAT JSON) ${captured.query}`, captured.params as never[]);
    });
    const plan = (rows[0] as unknown as { 'QUERY PLAN': Array<{ Plan: PlanNode }> })['QUERY PLAN'][0]!.Plan;
    return usageScans(plan);
  }

  async function seed(): Promise<void> {
    await makeGoal('goal-a');
    await makeGoal('goal-b');
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-a', harnessSlug: 'pot-a' });
    await linkPot(sql, { workspaceId: WS, goalId: 'goal-b', harnessSlug: 'pot-b' });
    const now = Date.now();
    for (let i = 0; i < 200; i++) {
      await spend(i % 2 === 0 ? 'pot-a' : 'pot-b', 0.01, now + i);
      await spend('unlinked-pot', 0.01, now + i);
    }
  }

  it('portfolioSpend reads agent_usage_samples with an Index Only Scan on the covering index', async () => {
    await seed();
    const captured = await captureUsageQuery((client) =>
      portfolioSpend(client, { workspaceId: WS, goalIds: ['goal-a', 'goal-b'] }),
    );
    const scans = await usageScanNodes(captured);
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      expect({ node: scan['Node Type'], index: scan['Index Name'] }).toEqual({
        node: 'Index Only Scan',
        index: 'agent_usage_samples_harness_idx',
      });
    }
  });

  it('goalSpend reads agent_usage_samples with an Index Only Scan on the covering index', async () => {
    await seed();
    const captured = await captureUsageQuery((client) => goalSpend(client, { workspaceId: WS, goalId: 'goal-a' }));
    const scans = await usageScanNodes(captured);
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      expect({ node: scan['Node Type'], index: scan['Index Name'] }).toEqual({
        node: 'Index Only Scan',
        index: 'agent_usage_samples_harness_idx',
      });
    }
  });
});
