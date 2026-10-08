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

type AdvisoryLockIdentity = { pid: number; key: string; database: string };

const advisoryLockCount = async (identity: AdvisoryLockIdentity): Promise<number> => {
  // pg_locks is cluster-wide even when createFreshTestDb isolates a database.
  // Attribute the granted two-int plan lock to its exact database and backend.
  const r = await obs<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory'
      AND database = (SELECT oid FROM pg_database WHERE datname = ${identity.database})
      AND pid = ${identity.pid}
      AND classid = hashtext('harness_plans')::oid
      AND objid = hashtext(${identity.key})::oid
      AND objsubid = 2 AND mode = 'ExclusiveLock' AND granted
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

  it('counts only the target lock despite other keys, backends and databases', async () => {
    const otherDb = await createFreshTestDb({ prefix: 'idletxnoise' });
    const sameDbNoise = postgres(db.url, { max: 1, onnotice: () => {} });
    const otherDbNoise = postgres(otherDb.url, { max: 1, onnotice: () => {} });
    const reserved = await getOrgPgApp().sql.reserve();
    const key = 'ws-test:papercup:isolated-plan';
    let waiter: Promise<unknown> | undefined;
    try {
      await sameDbNoise`SELECT pg_advisory_lock(hashtext('harness_plans'), hashtext('unrelated-plan'))`;
      await otherDbNoise`SELECT pg_advisory_lock(hashtext('harness_plans'), hashtext(${key}))`;
      await reserved.unsafe('BEGIN');
      await reserved.unsafe('SET LOCAL idle_in_transaction_session_timeout = 0');
      await reserved`SELECT pg_advisory_xact_lock(hashtext('harness_plans'), hashtext('other-owner-key'))`;
      const [{ pid }] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const identity = { pid, key, database: db.name };
      // Each distracting lock is real; none identifies this transaction's target.
      expect(await advisoryLockCount(identity)).toBe(0);
      await reserved`SELECT pg_advisory_xact_lock(hashtext('harness_plans'), hashtext(${key}))`;
      expect(await advisoryLockCount(identity)).toBe(1);
      const [{ pid: otherPid }] = await sameDbNoise<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      expect(await advisoryLockCount({ ...identity, pid: otherPid })).toBe(0);
      expect(await advisoryLockCount({ ...identity, database: otherDb.name })).toBe(0);
      expect(await advisoryLockCount({ ...identity, key: 'absent-plan' })).toBe(0);
      waiter = sameDbNoise`SELECT pg_advisory_lock(hashtext('harness_plans'), hashtext(${key}))`.then((rows) => rows);
      await expect.poll(async () => {
        const [{ n }] = await obs<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND pid = ${otherPid} AND NOT granted`;
        return n;
      }).toBe(1);
      // A waiter requests the same key but does not hold it yet.
      expect(await advisoryLockCount({ ...identity, pid: otherPid })).toBe(0);
      await reserved.unsafe('ROLLBACK');
      await waiter;
      expect(await advisoryLockCount(identity)).toBe(0);
      expect(await advisoryLockCount({ ...identity, pid: otherPid })).toBe(1);
    } finally {
      await reserved.unsafe('ROLLBACK').catch(() => {});
      reserved.release();
      await waiter?.catch(() => {});
      await Promise.all([sameDbNoise.end({ timeout: 5 }), otherDbNoise.end({ timeout: 5 })]);
      await otherDb.drop();
    }
  });

  it('retains the target lock with timeout disabled until explicit commit', async () => {
    const reserved = await getOrgPgApp().sql.reserve();
    const key = 'ws-test:papercup:no-timeout-plan';
    try {
      const [{ pid }] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const identity = { pid, key, database: db.name };
      await reserved.unsafe('BEGIN');
      // Override only this test transaction; buildClient's normal startup stays ON.
      await reserved.unsafe('SET LOCAL idle_in_transaction_session_timeout = 0');
      const [{ v }] = await reserved<{ v: string }[]>`
        SELECT current_setting('idle_in_transaction_session_timeout') AS v`;
      expect(v).toBe('0');
      await reserved`SELECT pg_advisory_xact_lock(hashtext('harness_plans'), hashtext(${key}))`;
      expect(await advisoryLockCount(identity)).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(await advisoryLockCount(identity)).toBe(1);
      await reserved.unsafe('COMMIT');
      expect(await advisoryLockCount(identity)).toBe(0);
    } finally {
      await reserved.unsafe('ROLLBACK').catch(() => {});
      reserved.release();
    }
  });

  it('auto-releases an advisory xact lock leaked by an idle-in-transaction connection', async () => {
    const { sql } = getOrgPgApp();
    // Reproduce the leak: reserve a real pooled connection, BEGIN, take the same
    // transaction-scoped advisory lock withPlanLock uses, then go idle WITHOUT
    // committing — exactly what a torn-down plans:* write leaves behind.
    const lockKey = 'ws-test:papercup:some-plan';
    const reserved = await sql.reserve();
    try {
      const [{ pid }] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const identity = { pid, key: lockKey, database: db.name };
      await reserved.unsafe('BEGIN');
      await reserved`
        SELECT pg_advisory_xact_lock(hashtext('harness_plans'), hashtext(${lockKey}))
      `;
      expect(await advisoryLockCount(identity)).toBe(1);

      // Observe this lock until the 1s idle-in-tx budget kills its backend.
      // Do not COMMIT or restart the process: the timeout must release it.
      await expect.poll(() => advisoryLockCount(identity), {
        timeout: 12_000, interval: 200,
      }).toBe(0);
    } finally {
      await reserved.unsafe('ROLLBACK').catch(() => {});
      // The backend may already be terminated; always return the reserved slot.
      try { reserved.release(); } catch { /* backend already terminated */ }
    }
  });
});
