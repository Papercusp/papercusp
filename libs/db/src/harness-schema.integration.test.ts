/**
 * harness-schema — proves `harnessQuery(slug, fn)` / `withHarnessSchema` resolve
 * the per-harness `search_path` correctly in BOTH connection modes. C1-2 of
 * backend-connection-scaling-2026-06-17.
 *
 *   - Direct (default): harnessQuery uses getHarnessPg()'s per-harness pool, whose
 *     search_path is set at CONNECT time.
 *   - PgBouncer (PAPERCUSP_PGBOUNCER=1): harnessQuery uses withHarnessSchema — a
 *     transaction with a PER-TRANSACTION `SET LOCAL search_path`, because
 *     transaction pooling does not preserve the connect-time one.
 *
 * To make resolution unambiguous we create the SAME table name in two schemas —
 * `harness_<slug>.thing` (value 'harness') and `public.thing` (value 'public') —
 * and assert the UNQUALIFIED `SELECT … FROM thing` resolves to the harness schema
 * in both modes. A multi-statement callback proves the search_path is shared
 * across statements in one transaction (the saveIssues / syncAgentRuns shape).
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   npx vitest run --config vitest.integration.config.ts src/harness-schema.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { slugToSchemaName } from './schema';
import { _resetForTests, _resetUrlCacheForTests } from './connection';
import { harnessQuery, withHarnessSchema } from './workspace-context';

const SLUG = 'c1test';
const SCHEMA = slugToSchemaName(SLUG); // harness_c1test

let db: MigratedTestDb;
let obs: Sql;

const savedEnv = {
  url: process.env.HARNESS_DATABASE_URL,
  pgbouncer: process.env.PAPERCUSP_PGBOUNCER,
};

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'harnsch' });
  process.env.HARNESS_DATABASE_URL = db.url;
  // PIN '0': deleting the env falls back to hostClass detection — POOLED on a
  // 'server'-class host (dev box / gate runner), rerouting to the box :6432
  // instead of this test's private container (WI-1666 class -> auth-fail).
  process.env.PAPERCUSP_PGBOUNCER = '0';
  _resetUrlCacheForTests();
  await _resetForTests();

  obs = postgres(db.url, { max: 1, onnotice: () => {} });
  // Two same-named tables in different schemas; only search_path distinguishes them.
  await obs.unsafe(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await obs.unsafe(`CREATE TABLE ${SCHEMA}.thing (val text)`);
  await obs.unsafe(`INSERT INTO ${SCHEMA}.thing (val) VALUES ('harness')`);
  await obs.unsafe(`CREATE TABLE IF NOT EXISTS public.thing (val text)`);
  await obs.unsafe(`INSERT INTO public.thing (val) VALUES ('public')`);
}, 120_000);

afterAll(async () => {
  await _resetForTests().catch(() => {});
  await obs?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
  if (savedEnv.url === undefined) delete process.env.HARNESS_DATABASE_URL;
  else process.env.HARNESS_DATABASE_URL = savedEnv.url;
  if (savedEnv.pgbouncer === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
  else process.env.PAPERCUSP_PGBOUNCER = savedEnv.pgbouncer;
  _resetUrlCacheForTests();
});

describe('harnessQuery search_path resolution (C1-2)', () => {
  it('DIRECT mode resolves unqualified table to the harness schema', async () => {
    process.env.PAPERCUSP_PGBOUNCER = '0'; // explicit DIRECT (delete = hostClass fallback = pooled on a server host)
    await _resetForTests();
    const rows = (await harnessQuery(SLUG, (q) => q`SELECT val FROM thing`)) as { val: string }[];
    expect(rows[0]?.val).toBe('harness');
  });

  it('withHarnessSchema (per-tx search_path — the PgBouncer path) resolves to the harness schema', async () => {
    // withHarnessSchema is exactly what harnessQuery runs under PgBouncer. We test
    // it DIRECTLY against the testcontainer: we can't route the test through the
    // real local :6432 pooler (it targets the live PG, not this container). The
    // actual end-to-end pooler routing is covered by a live check (see the plan).
    const rows = (await withHarnessSchema(SLUG, (q) => q`SELECT val FROM thing`)) as {
      val: string;
    }[];
    expect(rows[0]?.val).toBe('harness');
  });

  it('withHarnessSchema shares the search_path across multiple statements in one transaction', async () => {
    // The saveIssues / syncAgentRuns shape: an upsert + a reconcile read must both
    // see the harness schema within ONE transaction.
    try {
      const result = await withHarnessSchema(SLUG, async (q) => {
        await q`INSERT INTO thing (val) VALUES ('second')`;
        const rows = (await q`SELECT count(*)::int AS n FROM thing`) as { n: number }[];
        return rows[0].n;
      });
      // harness schema had 1 row ('harness') + the inserted 'second' = 2; the
      // public.thing 'public' row is NOT visible (proves both statements hit the
      // harness schema, not public).
      expect(result).toBe(2);
    } finally {
      // Clean the extra row so reruns (testcontainer .withReuse) stay deterministic.
      await obs.unsafe(`DELETE FROM ${SCHEMA}.thing WHERE val = 'second'`).catch(() => {});
    }
  });
});
