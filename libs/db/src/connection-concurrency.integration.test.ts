/**
 * connection-concurrency — proves the bounded org/app pool absorbs high
 * concurrency WITHOUT exhausting Postgres ("too many clients already" /
 * "remaining connection slots are reserved"). C4-1 of
 * backend-connection-scaling-2026-06-17.
 *
 * The per-agent-tool-call path is `withWorkspace(workspaceId, fn)` → a
 * transaction on the SHARED app-role pool returned by `getOrgPgApp()`. Pool
 * sizing is bounded by `boundedOrgPoolMax` (resource-profile) and overridable
 * via PAPERCUSP_DB_POOL_MAX, so N concurrent logical callers must all COMPLETE
 * by QUEUEING on the bounded pool — NOT by each opening its own backend and
 * blowing past `max_connections`.
 *
 * This runs against a REAL Postgres (testcontainer; Docker required) through the
 * real `getOrgPgApp()` / `withWorkspace()` code path (no mock of ./connection —
 * the point is to exercise the actual pool). An independent observer connection
 * samples `pg_stat_activity` to prove the number of backends THIS process's app
 * pool opens stays bounded while 300 logical queries are in flight.
 *
 * Run: cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/connection-concurrency.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { getOrgPgApp, _resetForTests, _resetUrlCacheForTests, withPriorityOrgPg } from './connection';
import { pgAcquireTimingSnapshot, withPgAcquireDiagnostics } from './acquire-registry';
import { withWorkspace } from './workspace-context';

// The pool max we pin for this test. Small + deterministic so the bound is
// obvious and the box isn't hammered. On a server-class host the resource
// profile's bound won't clamp a number this small, so the effective app-pool
// `max` is exactly this (verified in the first assertion below).
const POOL_MAX = 5;
// How many concurrent logical callers (agents) we simulate. Each goes through
// withWorkspace → a transaction on the shared app pool.
const CONCURRENCY = 300;
// Each query holds its backend briefly so the callers genuinely overlap in
// flight (otherwise fast SELECT 1s would serialize through 1-2 backends and the
// "bounded" assertion would be trivially true). 150ms × ceil(300/5) batches ≈
// a few seconds total — fast, not a stress test.
const HOLD_SECONDS = 0.15;

let db: MigratedTestDb;
let obs: Sql; // independent observer (its own backend; counts the app pool's backends)
let appPid: number; // backend pid of the observer, excluded from app-pool counts

const savedEnv = {
  url: process.env.HARNESS_DATABASE_URL,
  adminUrl: process.env.HARNESS_ADMIN_DATABASE_URL,
  poolMax: process.env.PAPERCUSP_DB_POOL_MAX,
  pgbouncer: process.env.PAPERCUSP_PGBOUNCER,
};

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'connconc' });
  // Point the real connection layer at the fresh DB and pin a small bounded pool.
  process.env.HARNESS_DATABASE_URL = db.url;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.url;
  process.env.PAPERCUSP_DB_POOL_MAX = String(POOL_MAX);
  // Make sure we exercise the DIRECT (non-pooler) path — that's where pool max ==
  // PG backends and the bound is load-bearing.
  // PIN '0' explicitly: deleting the env falls back to hostClass detection, which
  // is POOLED on a 'server'-class host (the dev box / gate runner) — the exact
  // opposite of this test's intent (rerouted :6432 -> auth-fail, WI-1666 class).
  process.env.PAPERCUSP_PGBOUNCER = '0';
  _resetUrlCacheForTests();
  await _resetForTests();
  obs = postgres(db.url, { max: 1, onnotice: () => {} });
  const [{ pid }] = await obs<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
  appPid = pid;
}, 120_000);

afterAll(async () => {
  await _resetForTests().catch(() => {});
  await obs?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
  if (savedEnv.url === undefined) delete process.env.HARNESS_DATABASE_URL;
  else process.env.HARNESS_DATABASE_URL = savedEnv.url;
  if (savedEnv.adminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
  else process.env.HARNESS_ADMIN_DATABASE_URL = savedEnv.adminUrl;
  if (savedEnv.poolMax === undefined) delete process.env.PAPERCUSP_DB_POOL_MAX;
  else process.env.PAPERCUSP_DB_POOL_MAX = savedEnv.poolMax;
  if (savedEnv.pgbouncer === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
  else process.env.PAPERCUSP_PGBOUNCER = savedEnv.pgbouncer;
  _resetUrlCacheForTests();
});

/**
 * Count the PG backends the app pool currently holds. We attribute them by the
 * `pcusp:org-app:p<pid>` application_name that `buildClient(..., 'org-app')` sets
 * AND by this datname, excluding the observer's own backend — so the count is
 * exactly the org/app pool's live backends against this database.
 */
const appBackendCount = async (): Promise<number> => {
  const r = await obs<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM pg_stat_activity
    WHERE datname = ${db.name}
      AND pid <> ${appPid}
      AND application_name LIKE 'pcusp:org-app:%'
  `;
  return r[0].n;
};

/** Total non-observer backends on this DB (defense-in-depth: nothing else leaks). */
const totalBackendCount = async (): Promise<number> => {
  const r = await obs<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM pg_stat_activity
    WHERE datname = ${db.name} AND pid <> ${appPid}
  `;
  return r[0].n;
};

describe('bounded org/app pool under high concurrency (C4-1)', () => {
  it('resolves the app pool to the pinned bounded max', async () => {
    // Sanity: the bound did NOT clamp our small POOL_MAX (so backends ≤ POOL_MAX
    // is the right ceiling to assert against below). Force the pool to build.
    const { sql } = getOrgPgApp();
    await sql`SELECT 1`;
    const opts = (sql as unknown as { options?: { max?: number } }).options;
    expect(opts?.max).toBe(POOL_MAX);
  });

  it('runs 300 concurrent withWorkspace queries: all succeed, backends stay bounded', async () => {
    let peakBackends = 0;
    let sampleCount = 0;
    let stopSampling = false;

    // Sample pg_stat_activity while the callers are in flight, tracking the peak
    // number of app-pool backends. This is the load-bearing observation: if the
    // pool were unbounded we'd see ~CONCURRENCY backends; bounded, we see ≤ POOL_MAX.
    const sampler = (async () => {
      while (!stopSampling) {
        const n = await appBackendCount();
        if (n > peakBackends) peakBackends = n;
        sampleCount++;
        await new Promise((r) => setTimeout(r, 20));
      }
    })();

    // Fire CONCURRENCY logical callers at once. Each takes the per-agent-tool-call
    // path: withWorkspace(ws, tx => trivial read). pg_sleep makes them overlap so
    // the excess MUST queue on the bounded pool rather than open a backend each.
    const tasks = Array.from({ length: CONCURRENCY }, (_, i) =>
      withWorkspace(`ws-conc-${i % 7}`, async (tx) => {
        const rows = await tx<{ ok: number }[]>`
          SELECT 1 AS ok FROM pg_sleep(${HOLD_SECONDS})
        `;
        return rows[0].ok;
      }),
    );

    const results = await Promise.allSettled(tasks);
    stopSampling = true;
    await sampler;

    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<number>[];

    // 1) NONE rejected — and specifically none with a PG connection-exhaustion error.
    const exhaustion = rejected.filter((r) => {
      const msg = String((r.reason as Error)?.message ?? r.reason ?? '');
      return /too many clients already|remaining connection slots|sorry, too many clients/i.test(msg);
    });
    expect(exhaustion).toHaveLength(0);
    if (rejected.length > 0) {
      // Surface the first failure verbatim so a non-exhaustion bug is debuggable.
      throw new Error(
        `${rejected.length}/${CONCURRENCY} withWorkspace calls rejected; first: ${String(
          (rejected[0].reason as Error)?.message ?? rejected[0].reason,
        )}`,
      );
    }

    // 2) ALL succeeded and returned the expected value.
    expect(fulfilled).toHaveLength(CONCURRENCY);
    expect(fulfilled.every((r) => r.value === 1)).toBe(true);

    // 3) The sampler actually observed the in-flight window (guards against a
    //    no-op assertion if everything somehow finished before the first sample).
    expect(sampleCount).toBeGreaterThan(0);
    expect(peakBackends).toBeGreaterThan(0);

    // 4) The core property: the app pool never opened more than its bounded max
    //    (+1 margin for sampling races / postgres-js's reserve handshake), even
    //    though CONCURRENCY (300) callers were in flight. Bounded pool ⇒ the
    //    excess queued instead of exhausting PG.
    expect(peakBackends).toBeLessThanOrEqual(POOL_MAX + 1);

    // 5) Nothing else leaked backends against this DB either.
    const total = await totalBackendCount();
    expect(total).toBeLessThanOrEqual(POOL_MAX + 1);

    // Diagnostic — printed so the run records the measured numbers.
    // eslint-disable-next-line no-console
    console.log(
      `[c4-1] concurrency=${CONCURRENCY} pool_max=${POOL_MAX} ` +
        `peak_app_backends=${peakBackends} samples=${sampleCount} ` +
        `succeeded=${fulfilled.length} rejected=${rejected.length}`,
    );
  }, 60_000);

  it('attributes withWorkspace acquisitions to the active priority app pool', async () => {
    const snapshot = await withPgAcquireDiagnostics('priority-app-label', async () => {
      await withPriorityOrgPg(async () => {
        await withWorkspace('ws-priority-pool', async (tx) => {
          await tx`SELECT 1`;
        });
      });
      return pgAcquireTimingSnapshot();
    });
    const pools = snapshot?.acquisitions.map(({ pool }) => pool) ?? [];
    expect(pools).toContain('org-app-priority');
    expect(pools).not.toContain('org-app');
  }, 30_000);
});
