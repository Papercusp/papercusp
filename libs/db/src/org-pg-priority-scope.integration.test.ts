import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { getOrgPg, getOrgPgApp, withPriorityOrgPg, _resetForTests, _resetUrlCacheForTests } from './connection';
import { withWorkspace } from './workspace-context';

let db: MigratedTestDb;
const keys = ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'PAPERCUSP_DB_POOL_MAX', 'PAPERCUSP_PGBOUNCER'] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'priorityorg' });
  process.env.HARNESS_ADMIN_DATABASE_URL = db.url;
  process.env.HARNESS_DATABASE_URL = db.url;
  process.env.PAPERCUSP_DB_POOL_MAX = '1';
  process.env.PAPERCUSP_PGBOUNCER = '0';
  await _resetForTests();
}, 120_000);

afterAll(async () => {
  await _resetForTests();
  await db?.drop();
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  _resetUrlCacheForTests();
});

describe('reserved authority connection capacity', () => {
  it('executes fresh reads while the entire ordinary pool is held', async () => {
    const ordinary = getOrgPg().sql;
    const held = await ordinary.reserve();
    let ordinaryFinished = false;
    const queued = ordinary`SELECT 1 AS value`.then(() => { ordinaryFinished = true; });
    try {
      const rows = await withPriorityOrgPg(async () => {
        expect(getOrgPg().sql).not.toBe(ordinary);
        return getOrgPg().sql`SELECT 42::int AS value`;
      });
      expect(rows[0].value).toBe(42);
      expect(ordinaryFinished).toBe(false);
      expect(getOrgPg().sql).toBe(ordinary);
    } finally {
      held.release();
      await queued;
    }
  }, 15_000);

  it('also isolates fresh workspace policy reads while preserving their RLS context', async () => {
    const ordinary = getOrgPgApp().sql;
    const held = await ordinary.reserve();
    let ordinaryFinished = false;
    const queued = ordinary`SELECT 1`.then(() => { ordinaryFinished = true; });
    try {
      const rows = await withPriorityOrgPg(() => withWorkspace('priority-scope-fixture', async tx => {
        expect(getOrgPgApp().sql).not.toBe(ordinary);
        return tx`SELECT current_setting('app.workspace_id') AS workspace`;
      }));
      expect(rows[0].workspace).toBe('priority-scope-fixture');
      expect(ordinaryFinished).toBe(false);
      expect(getOrgPgApp().sql).toBe(ordinary);
    } finally {
      held.release();
      await queued;
    }
  }, 15_000);

  it('does not lend priority capacity to work that outlives the request', async () => {
    const ordinary = getOrgPg().sql;
    let release!: () => void;
    const later = new Promise<void>(resolve => { release = resolve; });
    let child!: Promise<typeof ordinary>;
    await withPriorityOrgPg(async () => {
      child = later.then(() => getOrgPg().sql);
      expect(getOrgPg().sql).not.toBe(ordinary);
    });
    release();
    expect(await child).toBe(ordinary);
  });

  it('preserves an outer request across nested priority scopes', async () => {
    await withPriorityOrgPg(async () => {
      const outer = getOrgPg().sql;
      await withPriorityOrgPg(async () => { expect(getOrgPg().sql).toBe(outer); });
      expect(getOrgPg().sql).toBe(outer);
    });
  });

  it('fails closed if the database target changes during authority evaluation', async () => {
    const original = process.env.HARNESS_ADMIN_DATABASE_URL;
    try {
      await withPriorityOrgPg(async () => {
        process.env.HARNESS_ADMIN_DATABASE_URL = 'postgresql://unused@127.0.0.1:1/changed';
        _resetUrlCacheForTests();
        expect(() => getOrgPg()).toThrow('Priority org database target changed during request');
      });
    } finally {
      process.env.HARNESS_ADMIN_DATABASE_URL = original;
      _resetUrlCacheForTests();
    }
  });
});
