/**
 * migration-631-reslug-collision.integration.test.ts
 *
 * REGRESSION GUARD for the mac 0.0.12 crash-loop (2026-07-19): migration
 * `631-reslug-operator-workspace-changetask-to-papercusp.sql` re-slugs change/task
 * work-items from `operator:papercusp-workspace` to `papercusp`. Its first version
 * was a straight `UPDATE ... SET harness_slug='papercusp'` that ASSUMED zero
 * (harness_slug, feature_id) primary-key collisions. That assumption held on the
 * dev DB it was authored against but NOT on the shipped embedded-pg SEED — where a
 * `papercusp` row already existed for a moved feature_id — so on first boot the
 * packaged operator hit `duplicate key value violates unique constraint
 * "work_items_pkey"` and crash-looped. It was found only AFTER a ~45-minute build +
 * install + boot.
 *
 * This test reproduces that seed data-shape in a real Postgres and re-runs 631's
 * SQL, asserting it NO LONGER throws (the fix adds a dedup-DELETE mirroring 630) —
 * the exact class of failure a pre-flight readiness gate must catch in seconds,
 * not after a multi-hour release build (plan release-readiness-preflight-gate P-001).
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts \
 *     src/migration-631-reslug-collision.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, '..', 'sql');
const RUNNER = join(here, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');
const MIGRATION_631 = join(SQL_DIR, '631-reslug-operator-workspace-changetask-to-papercusp.sql');

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
      throw new Error(`migration-631 provision: applied ${appliedCount}/${totalKnown}`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'mig631', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 631 reslug operator→papercusp is collision-safe (mac 0.0.12 crash-loop regression)', () => {
  it('dedups a colliding operator-slug row and reslugs a non-colliding one, with NO work_items_pkey crash', async () => {
    // Reproduce the seed data-shape that crashed the packaged operator, at the
    // engineer_issues BASE table (the work_items view synthesizes harness_slug from
    // it: base_harness_slug='papercusp' → view 'papercusp'; base_harness_slug='' +
    // origin='local' + workspace='papercusp-workspace' → view
    // 'operator:papercusp-workspace').
    //  • EI-9990001 — a COLLISION: a 'papercusp' row AND an
    //    'operator:papercusp-workspace' row share the same feature_id. The old
    //    straight-UPDATE dup-keyed here (the mac crash).
    //  • EI-9990002 — a NON-colliding operator row that SHOULD be reslugged.
    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, base_harness_slug, base_origin, origin, kind, scope,
         title, body, state, severity, source, created_by, created_at, updated_at)
      VALUES
        ('papercusp-workspace', 'EI-9990001', 'papercusp', 'local', 'local', 'change', 'operator',
         'already here', 'b', 'open', 'minor', 'su', 'su-a', now(), now()),
        ('papercusp-workspace', 'EI-9990001', '',          'local', 'local', 'change', 'operator',
         'stale dup',    'b', 'open', 'minor', 'su', 'su-b', now(), now()),
        ('papercusp-workspace', 'EI-9990002', '',          'local', 'local', 'task',   'operator',
         'to be moved',  'b', 'open', 'minor', 'su', 'su-c', now(), now())`;

    // Sanity: the view shows the two view-slugs 631 keys on, before the migration.
    const before = await sql<{ harness_slug: string; feature_id: string }[]>`
      SELECT harness_slug, feature_id FROM harness_shared.work_items
       WHERE feature_id IN ('EI-9990001', 'EI-9990002') ORDER BY harness_slug`;
    expect(before.map((r) => r.harness_slug)).toContain('operator:papercusp-workspace');
    expect(before.map((r) => r.harness_slug)).toContain('papercusp');

    // Re-run 631's SQL against the seeded collision. The pre-fix straight UPDATE
    // dup-keyed here (the mac crash). The current (dedup-DELETE) version must NOT.
    const migration631 = readFileSync(MIGRATION_631, 'utf8');
    await expect(sql.unsafe(migration631)).resolves.toBeDefined();

    // The colliding operator-slug row is gone (the pre-existing papercusp row kept);
    // the non-colliding one is reslugged to papercusp. Nothing left on the old slug.
    const collide = await sql`SELECT harness_slug FROM harness_shared.work_items WHERE feature_id = 'EI-9990001'`;
    expect(collide.map((r) => r.harness_slug)).toEqual(['papercusp']);

    const moved = await sql`SELECT harness_slug FROM harness_shared.work_items WHERE feature_id = 'EI-9990002'`;
    expect(moved.map((r) => r.harness_slug)).toEqual(['papercusp']);

    const leftover = await sql`
      SELECT count(*)::int AS n FROM harness_shared.work_items
      WHERE harness_slug = 'operator:papercusp-workspace' AND item_kind IN ('change', 'task')`;
    expect(leftover[0].n).toBe(0);
  });
});
