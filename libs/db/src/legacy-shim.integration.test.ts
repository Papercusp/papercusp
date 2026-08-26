/**
 * legacy-shim — the better-sqlite3→postgres-js compat shim, proven against a
 * REAL Postgres (testcontainer; Docker required). The load-bearing logic is the
 * placeholder translation (`?` → `$1`, `@name` → `$N` reordered), exercised here
 * end-to-end through .get/.all/.run plus the transaction wrapper.
 *
 * Run: cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/legacy-shim.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ sql: null as unknown as Sql }));
vi.mock('./connection', () => ({
  getOrgPg: () => ({ sql: h.sql }),
  getHarnessPg: () => ({ sql: h.sql }),
}));

import { getLegacyClient } from './legacy-shim';

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'legshim',
    provision: async (url) => {
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(`CREATE TABLE kv (k text, v int)`);
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 4, onnotice: () => {} });
  h.sql = sql;
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

beforeEach(async () => {
  await sql`TRUNCATE kv`;
});

describe('getLegacyClient — positional ? placeholders', () => {
  it('run + all + get translate ? to $N and bind in order', async () => {
    const c = getLegacyClient();
    await c.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('a', 1);
    await c.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('b', 2);
    expect(await c.prepare('SELECT v FROM kv ORDER BY v').all()).toEqual([{ v: 1 }, { v: 2 }]);
    expect(await c.prepare('SELECT v FROM kv WHERE k = ?').get('a')).toEqual({ v: 1 });
  });

  it('get returns undefined for no rows', async () => {
    const c = getLegacyClient();
    expect(await c.prepare('SELECT v FROM kv WHERE k = ?').get('nope')).toBeUndefined();
  });

  it('throws on a placeholder/argument count mismatch', async () => {
    const c = getLegacyClient();
    await expect(c.prepare('SELECT ? + ?').get(1)).rejects.toThrow(/placeholder\/argument mismatch/);
  });
});

describe('getLegacyClient — @named placeholders', () => {
  it('binds named params by key (order-independent)', async () => {
    const c = getLegacyClient();
    await c.prepare('INSERT INTO kv (k, v) VALUES (@key, @val)').run({ val: 7, key: 'z' });
    expect(await c.prepare('SELECT v FROM kv WHERE k = @key').get({ key: 'z' })).toEqual({ v: 7 });
  });

  it('throws on a missing named param', async () => {
    const c = getLegacyClient();
    await expect(c.prepare('SELECT @missing').get({ other: 1 })).rejects.toThrow(/missing named param @missing/);
  });
});

describe('getLegacyClient — transaction', () => {
  it('rolls back when the callback throws', async () => {
    const c = getLegacyClient();
    await expect(
      c.transaction(async (tx) => {
        await tx.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('x', 9);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await c.prepare('SELECT count(*)::int AS n FROM kv').get()).toEqual({ n: 0 });
  });

  it('commits on success', async () => {
    const c = getLegacyClient();
    await c.transaction(async (tx) => {
      await tx.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run('ok', 1);
    });
    expect(await c.prepare('SELECT count(*)::int AS n FROM kv').get()).toEqual({ n: 1 });
  });
});
