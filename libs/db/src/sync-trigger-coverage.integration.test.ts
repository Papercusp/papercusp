/**
 * sync-trigger-coverage.integration.test.ts — migration 373 attaches harness_shared.emit_change_notify
 * to the low-churn synced/cache-backing tables that lacked it (caching-layer-tag-eca-2026-06-22 P-005).
 * Asserts every target content/config/state table is covered after the full migration chain applies.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/sync-trigger-coverage.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';

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

// The 28 tables migration 373 covers.
const TARGETS = [
  'harness_archives', 'harness_brainstorm', 'harness_checkpoints', 'harness_chunk_plans',
  'harness_decisions', 'harness_escalations', 'harness_feature_debug_notes', 'harness_feature_notes',
  'harness_lanes', 'harness_pending_issues', 'harness_project_files', 'harness_proposals_shared',
  'harness_screenshots', 'harness_skills', 'harness_smoke_test', 'harness_snapshots_consolidated',
  'harness_status', 'harness_tests', 'harness_text_artifacts', 'hive_members', 'hive_settings',
  'operator_budget', 'pending_reviews', 'plan_revisions', 'plan_runs', 'plugin_configs',
  'plugin_enables', 'project_spec_revisions',
];

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (o: { client: Sql; sqlDir: string }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    if (appliedCount !== totalKnown) throw new Error(`sync-trigger-coverage provision: ${appliedCount}/${totalKnown}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;
beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'synctrigcov', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
}, 180_000);
afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 373 — sync trigger coverage (P-005)', () => {
  it('every target synced content/config table that exists has emit_change_notify', async () => {
    const existing = (await sql`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'harness_shared' AND c.relkind = 'r' AND c.relname = ANY(${TARGETS})`) as { relname: string }[];
    const covered = (await sql`
      SELECT c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_trigger t ON t.tgrelid = c.oid AND NOT t.tgisinternal
        JOIN pg_proc p ON p.oid = t.tgfoid AND p.proname = 'emit_change_notify'
       WHERE n.nspname = 'harness_shared' AND c.relname = ANY(${TARGETS})`) as { relname: string }[];
    const coveredSet = new Set(covered.map((r) => r.relname));
    const missing = existing.map((r) => r.relname).filter((t) => !coveredSet.has(t));
    expect(missing).toEqual([]);
    expect(existing.length).toBeGreaterThan(0); // sanity: the schema actually has these tables
  });
});
