/**
 * backfill-work-item-deps.integration.test.ts — migration 370 backfills existing feature→feature
 * coord_links rel='blocks' edges into the dedicated work_item_deps table
 * (work-item-deps-and-readiness-2026-06-22 P-003 cutover step 1). Runs the ACTUAL migration SQL
 * against seeded coord_links data and asserts the mapping (blocked=dst, blocker=src), the scoping
 * (only feature→feature blocks edges), and idempotency.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/backfill-work-item-deps.integration.test.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, '..', 'sql');
const RUNNER = join(here, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');
const BACKFILL_SQL = readFileSync(join(SQL_DIR, '370-backfill-work-item-deps.sql'), 'utf8');

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
      throw new Error(`backfill provision: applied ${appliedCount}/${totalKnown} (expected zero skips)`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;

async function seedCoordLink(srcKind: string, srcRef: string, dstKind: string, dstRef: string, rel: string): Promise<void> {
  await sql.unsafe(
    `INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, dst_kind, dst_ref, rel)
       VALUES ('default',$1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [srcKind, srcRef, dstKind, dstRef, rel],
  );
}
async function depRows(): Promise<{ blocked_ref: string; blocker_ref: string }[]> {
  return (await sql.unsafe(
    `SELECT blocked_ref, blocker_ref FROM harness_shared.work_item_deps WHERE dep_type='blocks' ORDER BY blocked_ref`,
  )) as { blocked_ref: string; blocker_ref: string }[];
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'backfillwid', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`SELECT set_config('app.workspace_id', 'default', false)`);
  // Seed coord_links: src = BLOCKER, dst = BLOCKED (the feature-blockers-edges convention).
  await seedCoordLink('feature', 'h#F-A', 'feature', 'h#F-B', 'blocks'); // F-B blocked by F-A
  await seedCoordLink('feature', 'h#F-C', 'feature', 'h#F-D', 'blocks'); // F-D blocked by F-C
  await seedCoordLink('feature', 'h#F-E', 'topic', 't#x', 'tagged'); // NOT a blocks edge
  await seedCoordLink('issue', 'EI-1', 'feature', 'h#F-F', 'blocks'); // issue->feature (out of scope)
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 370 — backfill coord_links blocks -> work_item_deps', () => {
  it('copies ONLY feature→feature blocks edges, mapping blocked=dst / blocker=src', async () => {
    await sql.unsafe(BACKFILL_SQL);
    const rows = await depRows();
    expect(rows).toEqual([
      { blocked_ref: 'h#F-B', blocker_ref: 'h#F-A' },
      { blocked_ref: 'h#F-D', blocker_ref: 'h#F-C' },
    ]);
  });

  it('excludes tagged edges and issue→feature edges (scoped to feature→feature blocks)', async () => {
    const rows = await depRows();
    expect(rows.find((r) => r.blocked_ref === 'h#F-F')).toBeUndefined(); // issue->feature excluded
    expect(rows.some((r) => r.blocker_ref === 'h#F-E')).toBe(false); // tagged excluded
  });

  it('is idempotent — re-running the backfill adds no duplicates', async () => {
    const before = (await depRows()).length;
    await sql.unsafe(BACKFILL_SQL);
    await sql.unsafe(BACKFILL_SQL);
    expect((await depRows()).length).toBe(before);
  });
});
