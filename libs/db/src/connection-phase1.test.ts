import { describe, it, expect, afterAll } from 'vitest';
import { getOrgPg, getHarnessPg, typedSql, _resetForTests } from './connection';
import { generated } from './schema';

/**
 * Phase 1 smoke: verify the typed `.db` field is wired into the
 * org + per-harness handles and resolves all 125 generated tables.
 * Tests are live-DB — they connect to whatever HARNESS_ADMIN_DATABASE_URL
 * points at (defaults to local papercusp).
 */
describe('Drizzle migration phase 1 — connection surface', () => {
  afterAll(async () => {
    await _resetForTests();
  });

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
    // Either alias should work — confirm the generated one resolves.
    const result = await db
      .select({ count: generated.audit_logInHarness_shared.id })
      .from(generated.audit_logInHarness_shared)
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
