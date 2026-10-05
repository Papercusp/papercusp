/**
 * work-item-deps.integration.test.ts — migration 367 creates harness_shared.work_item_deps:
 * the dedicated first-class dependency table (work-item-deps-and-readiness-2026-06-22 P-002).
 * Asserts the scoped change-notify (carries blocked/blocker refs + correct app.workspace_id),
 * the unique-edge + no-self-block constraints, and the forward/reverse indexes.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/work-item-deps.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
      throw new Error(`work-item-deps provision: applied ${appliedCount}/${totalKnown} (expected zero skips)`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;
let listener: Sql;
interface Notif {
  name: string;
  args: { op: string; blocked_ref?: string; blocker_ref?: string; dep_type?: string; workspace_id?: string | null };
}
const received: Notif[] = [];
const NAME = 'harness_shared.work_item_deps.changed';
const depNotifs = (): Notif[] => received.filter((n) => n.name === NAME);
const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'workitemdeps', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`SELECT set_config('app.workspace_id', 'test-ws', false)`);
  listener = postgres(db.url, { max: 1, onnotice: () => {} });
  await listener.listen('sync_invalidate', (payload: string) => {
    try {
      received.push(JSON.parse(payload) as Notif);
    } catch {
      /* ignore */
    }
  });
}, 180_000);

afterAll(async () => {
  await listener?.end({ timeout: 5 }).catch(() => {});
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

async function insertEdge(blocked: string, blocker: string, depType = 'blocks'): Promise<void> {
  await sql.unsafe(
    `INSERT INTO harness_shared.work_item_deps (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
       VALUES ('test-ws','feature',$1,'feature',$2,$3)`,
    [blocked, blocker, depType],
  );
}

describe('migration 367 — work_item_deps', () => {
  it('emits a scoped notify with the affected refs + correct workspace_id on INSERT', async () => {
    received.length = 0;
    await insertEdge('WI-BLOCKED', 'WI-BLOCKER');
    await settle();
    const n = depNotifs();
    expect(n, JSON.stringify(n, null, 2)).toHaveLength(1);
    expect(n[0]!.args.op).toBe('INSERT');
    expect(n[0]!.args.blocked_ref).toBe('WI-BLOCKED');
    expect(n[0]!.args.blocker_ref).toBe('WI-BLOCKER');
    expect(n[0]!.args.dep_type).toBe('blocks');
    expect(n[0]!.args.workspace_id).toBe('test-ws');
  });

  it('emits on DELETE', async () => {
    await insertEdge('WI-D2', 'WI-B2');
    await settle();
    received.length = 0;
    await sql.unsafe(`DELETE FROM harness_shared.work_item_deps WHERE blocked_ref='WI-D2' AND blocker_ref='WI-B2'`);
    await settle();
    const n = depNotifs();
    expect(n, JSON.stringify(n, null, 2)).toHaveLength(1);
    expect(n[0]!.args.op).toBe('DELETE');
    expect(n[0]!.args.blocked_ref).toBe('WI-D2');
  });

  it('rejects a duplicate edge (unique constraint)', async () => {
    await insertEdge('WI-DUP', 'WI-SRC');
    await expect(insertEdge('WI-DUP', 'WI-SRC')).rejects.toThrow();
  });

  it('rejects a self-block edge (no-self-block check)', async () => {
    await expect(
      sql.unsafe(
        `INSERT INTO harness_shared.work_item_deps (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref)
           VALUES ('test-ws','feature','WI-SELF','feature','WI-SELF')`,
      ),
    ).rejects.toThrow();
  });

  it('has the forward + reverse + unique indexes', async () => {
    const idx = (await sql.unsafe(
      `SELECT indexname FROM pg_indexes WHERE schemaname='harness_shared' AND tablename='work_item_deps'`,
    )) as { indexname: string }[];
    const names = idx.map((r) => r.indexname);
    expect(names).toContain('work_item_deps_blocked_idx');
    expect(names).toContain('work_item_deps_blocker_idx');
    expect(names).toContain('work_item_deps_edge_uniq');
  });
});
