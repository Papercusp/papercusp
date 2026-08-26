/**
 * workspace-context — the RLS workspace-GUC transaction wrapper, proven against
 * a REAL Postgres (testcontainer; Docker required). Proves the load-bearing
 * property: `app.workspace_id` is set INSIDE the tx and is transaction-local,
 * the admin-bypass skips it, and a throwing callback rolls the tx back.
 *
 * Run: cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/workspace-context.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

// The wrapper resolves its client through ./connection — point both at our test sql.
const h = vi.hoisted(() => ({ sql: null as unknown as Sql }));
// SPREAD the real module rather than ENUMERATING it. The previous form listed the
// four exports ./connection happened to have when this file was written, so the
// moment workspace-context reached for a fifth the fixture stranded: adding
// `withAcquisitionDeadline` (2026-08-03) failed all six withWorkspace cases with
// `No "withAcquisitionDeadline" export is defined on the "./connection" mock` — in
// a file that change never touched, which is why `test:affected` could not select
// it. Only the pool getters actually need redirecting at the testcontainer client;
// everything else stays real, so a new export can no longer strand this fixture.
vi.mock('./connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./connection')>()),
  getOrgPgApp: () => ({ sql: h.sql }),
  getOrgPg: () => ({ sql: h.sql }),
  // workspace-context gates its per-txn search_path/GUC re-apply on this (C1-2).
  // The test's sql is a DIRECT testcontainer client — no pooler in between.
  pgbouncerEnabled: () => false,
  getHarnessPg: () => ({ sql: h.sql }),
}));

import { withWorkspace, withWorkspaceQuery } from './workspace-context';

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'wsctx',
    provision: async (url) => {
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(`CREATE TABLE scratch (id int)`);
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
  await sql`TRUNCATE scratch`;
});

const readGuc = (tx: Sql) => tx<{ ws: string | null }[]>`SELECT current_setting('app.workspace_id', true) AS ws`;

describe('withWorkspace', () => {
  it('throws on an empty workspaceId (no RLS bypass)', async () => {
    await expect(withWorkspace('', async () => 1)).rejects.toThrow(/workspaceId is empty/);
  });

  it('sets app.workspace_id inside the transaction', async () => {
    const rows = await withWorkspace('ws-42', async (tx) => readGuc(tx));
    expect(rows[0].ws).toBe('ws-42');
  });

  it('keeps the GUC transaction-local (cleared after the tx)', async () => {
    await withWorkspace('ws-42', async (tx) => readGuc(tx));
    const [after] = await readGuc(sql); // fresh statement, outside the tx
    expect(after.ws == null || after.ws === '').toBe(true);
  });

  it('admin-bypass skips setting the GUC', async () => {
    const rows = await withWorkspace('ignored', async (tx) => readGuc(tx), { bypassRlsForAdmin: true });
    expect(rows[0].ws == null || rows[0].ws === '').toBe(true);
  });

  it('rolls the transaction back when the callback throws', async () => {
    await expect(
      withWorkspace('ws-1', async (tx) => {
        await tx`INSERT INTO scratch (id) VALUES (1)`;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM scratch`;
    expect(n).toBe(0); // insert was rolled back
  });

  it('commits and returns the callback value on success', async () => {
    const out = await withWorkspace('ws-1', async (tx) => {
      await tx`INSERT INTO scratch (id) VALUES (7)`;
      return 'done';
    });
    expect(out).toBe('done');
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM scratch`;
    expect(n).toBe(1);
  });
});

describe('withWorkspaceQuery', () => {
  it('delegates to withWorkspace (single-query convenience)', async () => {
    const rows = await withWorkspaceQuery('ws-9', async (tx) => readGuc(tx));
    expect(rows[0].ws).toBe('ws-9');
  });
});
