import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { getOrgPg, getHarnessPg, typedSql, _resetForTests } from './connection';
import { generated } from './schema';

/**
 * Phase 1 smoke: verify the typed `.db` field is wired into the org +
 * per-harness handles and resolves all 125 generated tables.
 *
 * INTEGRATION tier (testcontainer; Docker required). Previously a unit-tier
 * `.test.ts` that connected to whatever HARNESS_ADMIN_DATABASE_URL pointed at
 * (default native :5432) — so it ECONNREFUSED in CI where there is no PG on
 * :5432 (WI-123). Now it provisions a fresh DB with the one table its two
 * DB-querying assertions touch (`harness_shared.audit_log`) and points the
 * connection env at it, so it runs honestly in CI + locally.
 */
let db: MigratedTestDb;
const savedAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
const savedAppUrl = process.env.HARNESS_DATABASE_URL;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'connphase1',
    provision: async (url) => {
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
        // Minimal stand-in matching the baseline audit_log columns the two
        // DB-querying assertions read (id, ts) — the rest mirror the real shape.
        await s.unsafe(`
          CREATE TABLE IF NOT EXISTS harness_shared.audit_log (
            id           text NOT NULL,
            ts           bigint NOT NULL,
            actor        text NOT NULL DEFAULT 'user',
            action       text NOT NULL DEFAULT '',
            subject      text NOT NULL DEFAULT '',
            details      jsonb,
            workspace_id text NOT NULL DEFAULT 'default',
            CONSTRAINT audit_log_pkey PRIMARY KEY (id)
          )`);
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  // getOrgPg (admin) + getHarnessPg (app) resolve their URL from these envs;
  // _resetForTests clears the cached pools so the next call rebuilds on db.url.
  process.env.HARNESS_ADMIN_DATABASE_URL = db.url;
  process.env.HARNESS_DATABASE_URL = db.url;
  await _resetForTests();
});

afterAll(async () => {
  await _resetForTests();
  if (savedAdminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
  else process.env.HARNESS_ADMIN_DATABASE_URL = savedAdminUrl;
  if (savedAppUrl === undefined) delete process.env.HARNESS_DATABASE_URL;
  else process.env.HARNESS_DATABASE_URL = savedAppUrl;
  await db?.drop();
});

describe('Drizzle migration phase 1 — connection surface', () => {
  it('getOrgPg() exposes both .drizzle (back-compat) and .db (typed full schema)', () => {
    const h = getOrgPg();
    expect(h.sql).toBeDefined();
    expect(h.drizzle).toBeDefined();
    expect(h.db).toBeDefined();
    expect(h.drizzle).not.toBe(h.db); // separate drizzle instances; different schemas
  });

  it('.db can resolve a generated table via select()', async () => {
    const { db } = getOrgPg();
    // audit_log is one of the 5 hand-written tables that also exists in generated.ts.
    // Either alias should work — confirm the generated one resolves. (drizzle-kit
    // regenerated the export name to the camelCase `auditLogInHarnessShared`.)
    const result = await db
      .select({ count: generated.auditLogInHarnessShared.id })
      .from(generated.auditLogInHarnessShared)
      .limit(1);
    expect(Array.isArray(result)).toBe(true);
  });

  it('.db relational query API enumerates all 125 introspected tables', () => {
    const { db } = getOrgPg();
    const tableNames = Object.keys((db as any)._.fullSchema ?? db.query ?? {});
    // We expect ≥125 (the hand-written 5 dupes also appear; relations adds more).
    expect(tableNames.length).toBeGreaterThanOrEqual(125);
  });

  it('getHarnessPg(slug) exposes the same surface', () => {
    const h = getHarnessPg('sheets');
    expect(h.sql).toBeDefined();
    expect(h.drizzle).toBeDefined();
    expect(h.db).toBeDefined();
    expect(typeof h.lastUsed).toBe('number');
  });

  it('typedSql() narrows the row type on a raw query', async () => {
    type AuditRow = { id: string; ts: number };
    const { sql } = getOrgPg();
    const q = typedSql<AuditRow>(sql);
    const rows = await q`SELECT id, ts FROM harness_shared.audit_log LIMIT 1`;
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length > 0) {
      expect(typeof rows[0].id).toBe('string');
      expect(typeof rows[0].ts).toBe('number');
    }
  });
});
