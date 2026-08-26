/**
 * idle_in_transaction_session_timeout — the EI-49 regression.
 *
 * EI-49: a plans:* MCP WRITE whose transport drops mid-call returns its
 * connection to the pool still BEGIN-open, holding the transaction-scoped
 * advisory lock that `withPlanLock` takes (pg_advisory_xact_lock). That lock
 * only releases on COMMIT/ROLLBACK, so it leaks until the exact connection is
 * reused or the process restarts — wedging the plans subsystem fleet-wide.
 *
 * The fix sets `idle_in_transaction_session_timeout` at connection startup in
 * `buildClient` so Postgres auto-terminates a stuck idle-in-transaction backend,
 * releasing its locks without an operator restart. This test reproduces the leak
 * against a REAL Postgres (testcontainer; Docker required) on a client built
 * through the real `getOrgPgApp()` path, and proves the leaked advisory lock
 * self-heals.
 *
 * Run: cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/idle-in-tx-timeout.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { getOrgPgApp, _resetForTests, _resetUrlCacheForTests } from './connection';

let db: MigratedTestDb;
let obs: Sql; // independent observer connection (its own backend)

// Save/restore the env knobs we mutate so we don't bleed into sibling suites.
const savedEnv = {
  url: process.env.HARNESS_DATABASE_URL,
  idleTx: process.env.PAPERCUSP_DB_IDLE_IN_TX_TIMEOUT,
  poolMax: process.env.PAPERCUSP_DB_POOL_MAX,
};

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'idletx' });
  // Point the real connection layer at the fresh DB and give it a 1s
  // idle-in-tx budget so the regression resolves fast.
  process.env.HARNESS_DATABASE_URL = db.url;
  process.env.PAPERCUSP_DB_IDLE_IN_TX_TIMEOUT = '1';
  process.env.PAPERCUSP_DB_POOL_MAX = '2';
  _resetUrlCacheForTests();
  await _resetForTests();
  obs = postgres(db.url, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  await _resetForTests().catch(() => {});
  await obs?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
  process.env.HARNESS_DATABASE_URL = savedEnv.url;
  process.env.PAPERCUSP_DB_IDLE_IN_TX_TIMEOUT = savedEnv.idleTx;
  process.env.PAPERCUSP_DB_POOL_MAX = savedEnv.poolMax;
  _resetUrlCacheForTests();
});

const advisoryLockCount = async (): Promise<number> => {
  // On a fresh testcontainer DB the only advisory lock present is the one our
  // leaked transaction holds, so a plain count is an unambiguous signal.
  const r = await obs<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'
  `;
  return r[0].n;
};

describe('idle_in_transaction_session_timeout (EI-49)', () => {
  it('applies the GUC to every pooled connection built via buildClient', async () => {
    const { sql } = getOrgPgApp();
    const [{ v }] = await sql<{ v: string }[]>`
      SELECT current_setting('idle_in_transaction_session_timeout') AS v
    `;
    // PG echoes it back in a human unit (e.g. '1s' / '1000ms'); the key
    // property is that it is set (non-zero) — without the fix it defaults to '0'.
    expect(v).not.toBe('0');
  });

  it('auto-releases an advisory xact lock leaked by an idle-in-transaction connection', async () => {
    const { sql } = getOrgPgApp();
    // Reproduce the leak: reserve a real pooled connection, BEGIN, take the same
    // transaction-scoped advisory lock withPlanLock uses, then go idle WITHOUT
    // committing — exactly what a torn-down plans:* write leaves behind.
    const lockKey = 'ws-test:papercup:some-plan';
    const reserved = await sql.reserve();
    await reserved.unsafe('BEGIN');
    await reserved`
      SELECT pg_advisory_xact_lock(hashtext('harness_plans'), hashtext(${lockKey}))
    `;

    // Sanity: the lock is genuinely held right now.
    expect(await advisoryLockCount()).toBe(1);

    // With the 1s idle-in-tx budget, Postgres terminates the stuck backend and
    // the lock disappears on its own — no COMMIT, no process restart. Poll until
    // it clears (well within the budget + margin). Before the fix the GUC is 0,
    // the connection stays idle-in-tx forever, and this never reaches 0.
    const deadline = Date.now() + 12_000;
    let count = await advisoryLockCount();
    while (count > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      count = await advisoryLockCount();
    }
    expect(count).toBe(0);

    // The reserved handle's backend is gone; release best-effort so the pool
    // doesn't hold a dead slot for the rest of the suite.
    try {
      reserved.release();
    } catch {
      /* backend already terminated */
    }
  });
});
