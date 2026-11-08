/**
 * cache-l2.integration.test.ts — migration 369 creates harness_shared.cache_l2:
 * the UNLOGGED L2 cache tier behind @papercusp/cache's seam
 * (caching-layer-tag-eca-2026-06-22 P-003).
 *
 * Drives the REAL PgL2Store adapter (operator-core/lib/cache/pg-l2-store) against a
 * fresh testcontainer DB — `getOrgPg` is mocked to hand the adapter a client bound
 * to that DB. Asserts the set/get round-trip, tag-sweep invalidation, hard-TTL
 * expiry (an expired row reads as a miss + sweeps), workspace isolation (D-010), and
 * that the table is UNLOGGED with the expected indexes.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/cache-l2.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

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
      throw new Error(`cache-l2 provision: applied ${appliedCount}/${totalKnown} (expected zero skips)`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

// A controllable clock the adapter reads for expiry stamping/reading.
let nowMs = 1_000_000;
const clock = (): number => nowMs;

let db: MigratedTestDb;
let sql: Sql;

// The adapter only touches `getOrgPg().sql`; hand it our test-DB client.
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql }),
}));

// Imported AFTER the mock is registered (vi.mock is hoisted, so this is safe).
const { PgL2Store } = await import('@papercusp/operator-core/lib/cache/pg-l2-store');

let store: InstanceType<typeof PgL2Store>;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'cachel2', provision });
  sql = postgres(db.url, { max: 4, onnotice: () => {} });
  store = new PgL2Store({ clock });
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 369 — cache_l2 + PgL2Store', () => {
  it('the table is UNLOGGED with the unique-key + tag-GIN + expiry indexes', async () => {
    const rel = (await sql.unsafe(
      `SELECT relpersistence FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='harness_shared' AND c.relname='cache_l2'`,
    )) as { relpersistence: string }[];
    expect(rel).toHaveLength(1);
    expect(rel[0]!.relpersistence).toBe('u'); // 'u' = UNLOGGED

    const idx = (await sql.unsafe(
      `SELECT indexname FROM pg_indexes WHERE schemaname='harness_shared' AND tablename='cache_l2'`,
    )) as { indexname: string }[];
    const names = idx.map((r) => r.indexname);
    expect(names).toContain('cache_l2_key_uniq');
    expect(names).toContain('cache_l2_tags_gin');
    expect(names).toContain('cache_l2_expires_idx');
  });

  it('round-trips set → get with value, tags, and generation', async () => {
    await store.set('ws1', 'k1', { hello: 'world', n: 42 }, { tags: ['t:a', 't:b'], generation: 7 });
    const got = await store.get<{ hello: string; n: number }>('ws1', 'k1');
    expect(got).toBeDefined();
    expect(got!.value).toEqual({ hello: 'world', n: 42 });
    expect(got!.tags.sort()).toEqual(['t:a', 't:b']);
    expect(got!.generation).toBe(7);
    expect(got!.expiresAt).toBeNull();
  });

  it('returns undefined for an absent key', async () => {
    expect(await store.get('ws1', 'does-not-exist')).toBeUndefined();
  });

  it('set upserts (replaces value + tags) for the same key', async () => {
    await store.set('ws1', 'k-upsert', 'first', { tags: ['old'] });
    await store.set('ws1', 'k-upsert', 'second', { tags: ['new'] });
    const got = await store.get<string>('ws1', 'k-upsert');
    expect(got!.value).toBe('second');
    expect(got!.tags).toEqual(['new']); // old tag gone, no lingering stale tags
  });

  it('reuses existing TOAST storage when refreshing an unchanged large value', async () => {
    const value = randomBytes(512 * 1024).toString('base64');
    const toastBytes = async (): Promise<number> => {
      const rows = (await sql`
        SELECT pg_relation_size(c.reltoastrelid)::bigint AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='harness_shared' AND c.relname='cache_l2'
      `) as { bytes: string }[];
      return Number(rows[0]!.bytes);
    };

    await store.set('ws1', 'large-stable', value, { tags: ['stable'], hardTtlMs: 45_000 });
    const initialToastBytes = await toastBytes();
    for (let i = 0; i < 3; i++) {
      nowMs += 1;
      await store.set('ws1', 'large-stable', value, { tags: ['stable'], hardTtlMs: 45_000 });
    }

    expect(await toastBytes()).toBe(initialToastBytes);
    expect((await store.get<string>('ws1', 'large-stable'))!.value).toBe(value);
  });

  it('invalidateByTag evicts every entry carrying the tag (array overlap)', async () => {
    await store.set('ws1', 'a', 1, { tags: ['shared', 'only-a'] });
    await store.set('ws1', 'b', 2, { tags: ['shared'] });
    await store.set('ws1', 'c', 3, { tags: ['unrelated'] });
    const evicted = await store.invalidateByTag('ws1', 'shared');
    expect(evicted).toBe(2);
    expect(await store.get('ws1', 'a')).toBeUndefined();
    expect(await store.get('ws1', 'b')).toBeUndefined();
    expect((await store.get<number>('ws1', 'c'))!.value).toBe(3); // untouched
  });

  it('invalidateByTags with no tags is a no-op (never sweeps everything)', async () => {
    await store.set('ws1', 'keep', 'v', { tags: ['x'] });
    expect(await store.invalidateByTags('ws1', [])).toBe(0);
    expect((await store.get<string>('ws1', 'keep'))!.value).toBe('v');
  });

  it('treats a hard-TTL-expired row as a miss, then sweepExpired reclaims it', async () => {
    nowMs = 1_000_000;
    await store.set('ws1', 'ttl', 'soon-gone', { hardTtlMs: 5_000 });
    expect((await store.get<string>('ws1', 'ttl'))!.value).toBe('soon-gone'); // fresh

    nowMs = 1_000_000 + 6_000; // past expiry
    expect(await store.get('ws1', 'ttl')).toBeUndefined(); // expired ⇒ miss (no stale serve)

    // row still physically present until swept
    const before = (await sql.unsafe(
      `SELECT count(*)::int AS c FROM harness_shared.cache_l2 WHERE workspace_id='ws1' AND cache_key='ttl'`,
    )) as { c: number }[];
    expect(before[0]!.c).toBe(1);

    const reclaimed = await store.sweepExpired();
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    const after = (await sql.unsafe(
      `SELECT count(*)::int AS c FROM harness_shared.cache_l2 WHERE workspace_id='ws1' AND cache_key='ttl'`,
    )) as { c: number }[];
    expect(after[0]!.c).toBe(0);
  });

  it('caches a null value (negative caching) distinct from a miss', async () => {
    await store.set('ws1', 'neg', null, { tags: ['n'] });
    const got = await store.get('ws1', 'neg');
    expect(got).toBeDefined();
    expect(got!.value).toBeNull();
  });

  it('keeps identical keys isolated across workspaces (D-010)', async () => {
    await store.set('wsA', 'same', 'A-value', { tags: ['shared-tag'] });
    await store.set('wsB', 'same', 'B-value', { tags: ['shared-tag'] });
    // a tag invalidation in wsA must not touch wsB
    await store.invalidateByTag('wsA', 'shared-tag');
    expect(await store.get('wsA', 'same')).toBeUndefined();
    expect((await store.get<string>('wsB', 'same'))!.value).toBe('B-value');
  });

  it('forget drops one key regardless of tags', async () => {
    await store.set('ws1', 'forgettable', 'v', { tags: ['t'] });
    await store.forget('ws1', 'forgettable');
    expect(await store.get('ws1', 'forgettable')).toBeUndefined();
  });

  it('rejects an empty workspaceId (cross-workspace leak guard)', async () => {
    await expect(store.get('', 'k')).rejects.toThrow(/workspaceId/);
    await expect(store.set('', 'k', 1)).rejects.toThrow(/workspaceId/);
  });
});
