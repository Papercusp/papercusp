/**
 * withWorkspaceLegacy — proves the WI-4995(a) PgBouncer-routing fix: when a
 * harness `slug` is given, the legacy workspace-scoped shim now runs through
 * `withHarnessSchema` (the SAME per-transaction `search_path` chokepoint
 * `harnessQuery` uses under the pooler) instead of a direct `getHarnessPg(slug)`
 * connection — in BOTH connection modes — while still setting
 * `app.workspace_id` inside that SAME transaction (the RLS-scoping contract
 * `withWorkspaceLegacy` exists for).
 *
 * Mirrors harness-schema.integration.test.ts's method: two same-named tables in
 * different schemas, toggling PAPERCUSP_PGBOUNCER, asserting the unqualified
 * table resolves to the harness schema in both modes.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   npx vitest run --config vitest.integration.config.ts src/legacy-shim-workspace.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { slugToSchemaName } from './schema';
import { _resetForTests, _resetUrlCacheForTests } from './connection';
import { withWorkspaceLegacy } from './legacy-shim';

const SLUG = 'wslegacytest';
const SCHEMA = slugToSchemaName(SLUG); // harness_wslegacytest

let db: MigratedTestDb;
let obs: Sql;

const savedEnv = {
  url: process.env.HARNESS_DATABASE_URL,
  pgbouncer: process.env.PAPERCUSP_PGBOUNCER,
};

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'wslegacy' });
  process.env.HARNESS_DATABASE_URL = db.url;
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

describe('withWorkspaceLegacy(slug, …) — search_path + app.workspace_id (WI-4995a)', () => {
  it('DIRECT mode (pgbouncer disabled): resolves the harness schema and sets app.workspace_id', async () => {
    process.env.PAPERCUSP_PGBOUNCER = '0';
    await _resetForTests();
    const [row, ws] = await withWorkspaceLegacy(SLUG, 'ws-direct', async (legacy) => {
      const val = (await legacy.prepare('SELECT val FROM thing').get()) as { val: string } | undefined;
      const wsRow = (await legacy.prepare(
        `SELECT current_setting('app.workspace_id', true) AS w`,
      ).get()) as { w: string };
      return [val?.val, wsRow.w];
    });
    expect(row).toBe('harness');
    expect(ws).toBe('ws-direct');
  });

  it('POOLED mode (pgbouncer enabled): resolves the harness schema via per-tx search_path and sets app.workspace_id in the SAME transaction', async () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    await _resetForTests();
    try {
      const [row, ws] = await withWorkspaceLegacy(SLUG, 'ws-pooled', async (legacy) => {
        const val = (await legacy.prepare('SELECT val FROM thing').get()) as { val: string } | undefined;
        const wsRow = (await legacy.prepare(
          `SELECT current_setting('app.workspace_id', true) AS w`,
        ).get()) as { w: string };
        return [val?.val, wsRow.w];
      });
      expect(row).toBe('harness'); // proves it did NOT fall back to the direct getHarnessPg(slug) path's stale search_path — it went through withHarnessSchema
      expect(ws).toBe('ws-pooled');
    } finally {
      process.env.PAPERCUSP_PGBOUNCER = '0';
      await _resetForTests();
    }
  });

  it('POOLED mode: the GUC is transaction-local (cleared after the call returns)', async () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    await _resetForTests();
    try {
      await withWorkspaceLegacy(SLUG, 'ws-scoped', async (legacy) => {
        await legacy.prepare('SELECT 1').get();
      });
      const [after] = await obs<{ w: string | null }[]>`SELECT current_setting('app.workspace_id', true) AS w`;
      expect(after.w == null || after.w === '').toBe(true);
    } finally {
      process.env.PAPERCUSP_PGBOUNCER = '0';
      await _resetForTests();
    }
  });

  it('POOLED mode: multiple statements in one callback share BOTH the search_path and the workspace GUC', async () => {
    process.env.PAPERCUSP_PGBOUNCER = '1';
    await _resetForTests();
    try {
      const result = await withWorkspaceLegacy(SLUG, 'ws-multi', async (legacy) => {
        await legacy.prepare(`INSERT INTO thing (val) VALUES ('second')`).run();
        const count = (await legacy.prepare('SELECT count(*)::int AS n FROM thing').get()) as { n: number };
        const wsRow = (await legacy.prepare(
          `SELECT current_setting('app.workspace_id', true) AS w`,
        ).get()) as { w: string };
        return { n: count.n, w: wsRow.w };
      });
      // harness schema had 1 row ('harness') + the inserted 'second' = 2; the
      // public.thing 'public' row is NOT visible (proves every statement in the
      // callback hit the harness schema, not public).
      expect(result.n).toBe(2);
      expect(result.w).toBe('ws-multi');
    } finally {
      await obs.unsafe(`DELETE FROM ${SCHEMA}.thing WHERE val = 'second'`).catch(() => {});
      process.env.PAPERCUSP_PGBOUNCER = '0';
      await _resetForTests();
    }
  });

  it('rolls back the transaction (and the GUC) when the callback throws, in both modes', async () => {
    for (const mode of ['0', '1']) {
      process.env.PAPERCUSP_PGBOUNCER = mode;
      await _resetForTests();
      try {
        await expect(
          withWorkspaceLegacy(SLUG, 'ws-boom', async (legacy) => {
            await legacy.prepare(`INSERT INTO thing (val) VALUES ('rollback-me')`).run();
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        const [{ n }] = (await obs.unsafe(
          `SELECT count(*)::int AS n FROM ${SCHEMA}.thing WHERE val = 'rollback-me'`,
        )) as unknown as { n: number }[];
        expect(n).toBe(0);
      } finally {
        process.env.PAPERCUSP_PGBOUNCER = '0';
        await _resetForTests();
      }
    }
  });
});
