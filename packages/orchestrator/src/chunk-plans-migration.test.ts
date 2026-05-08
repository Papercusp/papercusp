import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Structural sanity test for `042-harness-chunk-plans.sql`. We don't
 * have a real-postgres test harness in this package, so a true
 * roundtrip test would require new infrastructure. Instead this test
 * parses the migration text and asserts on the things we can verify
 * without a live DB:
 *
 *   - The expected table is created with the expected columns.
 *   - Workspace-scoping (RLS) is enabled and the policy is correct.
 *   - GRANT statements exist for harness_app and harness_admin.
 *   - The harness_zero GRANT comes BEFORE the publication ADD TABLE
 *     (the documented memory note: feedback_zero_cache_grant_before_publication —
 *     the publication add fails permission-wise if the GRANT hasn't
 *     happened yet, and zero-cache crashloops).
 *   - Indexes for the access patterns we care about exist.
 *
 * If any of these regress (e.g. someone adds a column without
 * updating chunk-plan-pg.ts), the parse test catches it before the
 * migration runs in production.
 */

const MIGRATION_REL = '../../../libs/db/sql/042-harness-chunk-plans.sql';

async function readMigration(): Promise<string> {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const abs = path.resolve(here, MIGRATION_REL);
  return await fs.readFile(abs, 'utf8');
}

test('migration creates harness_shared.harness_chunk_plans with expected columns', async () => {
  const sql = await readMigration();
  // Match the CREATE TABLE statement (multi-line via [\s\S]) and pull
  // its body out for column inspection.
  const m = /CREATE TABLE IF NOT EXISTS harness_shared\.harness_chunk_plans\s*\(([\s\S]*?)\);/m
    .exec(sql);
  assert.ok(m, 'CREATE TABLE for harness_chunk_plans not found');
  const body = m![1];

  const expectedColumns = [
    'workspace_id',
    'harness_slug',
    'feature_id',
    'chunk_id',
    'chunk_index',
    'files',
    'description',
    'status',
    'strikes',
    'last_error',
    'commit_sha',
    'created_ts',
    'updated_ts',
  ];
  for (const col of expectedColumns) {
    assert.ok(
      new RegExp(`\\b${col}\\b`).test(body),
      `column ${col} missing from CREATE TABLE`,
    );
  }

  // Primary key includes the four scoping columns.
  assert.match(
    body,
    /PRIMARY KEY \(workspace_id,\s*harness_slug,\s*feature_id,\s*chunk_id\)/,
    'PRIMARY KEY shape is wrong',
  );
});

test('migration enables RLS with a workspace_id policy', async () => {
  const sql = await readMigration();
  assert.match(
    sql,
    /ALTER TABLE harness_shared\.harness_chunk_plans ENABLE ROW LEVEL SECURITY/,
    'RLS not enabled',
  );
  assert.match(sql, /CREATE POLICY chunk_plans_workspace_isolation/, 'RLS policy not created');
  // The policy must reference current_setting('app.workspace_id'…) on
  // BOTH USING and WITH CHECK so reads + writes are scoped.
  assert.match(
    sql,
    /USING \(workspace_id = current_setting\('app\.workspace_id'/,
    "RLS policy missing USING (workspace_id = current_setting('app.workspace_id', …))",
  );
  assert.match(
    sql,
    /WITH CHECK \(workspace_id = current_setting\('app\.workspace_id'/,
    'RLS policy missing WITH CHECK',
  );
});

test('migration grants the right privileges to harness_app and harness_admin', async () => {
  const sql = await readMigration();
  assert.match(
    sql,
    /GRANT SELECT, INSERT, UPDATE, DELETE\s*ON harness_shared\.harness_chunk_plans TO harness_app/,
    'harness_app GRANT missing or wrong',
  );
  assert.match(
    sql,
    /GRANT ALL ON harness_shared\.harness_chunk_plans TO harness_admin/,
    'harness_admin GRANT missing or wrong',
  );
});

test('harness_zero GRANT precedes the publication ADD TABLE (avoid zero-cache crashloop)', async () => {
  const sql = await readMigration();
  const grantIdx = sql.search(/GRANT SELECT ON harness_shared\.harness_chunk_plans TO harness_zero/);
  const pubIdx = sql.search(/ALTER PUBLICATION harness_shared_pub\s*ADD TABLE harness_shared\.harness_chunk_plans/);
  assert.notEqual(grantIdx, -1, 'harness_zero GRANT not found');
  assert.notEqual(pubIdx, -1, 'publication ADD TABLE not found');
  assert.ok(
    grantIdx < pubIdx,
    `harness_zero GRANT (idx ${grantIdx}) must come before publication ADD TABLE (idx ${pubIdx}) — see feedback_zero_cache_grant_before_publication memory`,
  );
});

test('migration creates the indexes the chunk-plan-pg helpers need', async () => {
  const sql = await readMigration();
  // by-feature index for the plan-reconstruction read path (readPlan ORDER BY chunk_index).
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS idx_chunk_plans_by_feature\s*ON harness_shared\.harness_chunk_plans \(workspace_id, harness_slug, feature_id, chunk_index\)/,
    'idx_chunk_plans_by_feature missing or wrong',
  );
  // by-status partial index for the in-progress / failing / escalated lane.
  assert.match(
    sql,
    /CREATE INDEX IF NOT EXISTS idx_chunk_plans_by_status\s*ON harness_shared\.harness_chunk_plans \(workspace_id, harness_slug, status\)\s*WHERE status IN \('in_progress', 'failing', 'escalated'\)/,
    'idx_chunk_plans_by_status missing or wrong',
  );
});

test('migration is wrapped in a single transaction', async () => {
  const sql = await readMigration();
  assert.match(sql, /^BEGIN;/m, 'migration must start with BEGIN');
  assert.match(sql, /COMMIT;\s*$/m, 'migration must end with COMMIT');
  assert.match(sql, /\\set ON_ERROR_STOP on/m, 'ON_ERROR_STOP must be set so partial applies abort cleanly');
});

test('migration is idempotent (uses IF NOT EXISTS / DROP IF EXISTS / DO blocks)', async () => {
  const sql = await readMigration();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS harness_shared\.harness_chunk_plans/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_chunk_plans_by_feature/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_chunk_plans_by_status/);
  // Policies don't have IF NOT EXISTS, so we DROP first.
  assert.match(sql, /DROP POLICY IF EXISTS chunk_plans_workspace_isolation/);
  // The harness_zero GRANT and publication add are inside DO $$ blocks
  // so they no-op when the role/publication doesn't exist (e.g. local
  // dev without zero-cache wired up).
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero'\)/);
  assert.match(sql, /IF EXISTS \(SELECT 1 FROM pg_publication WHERE pubname = 'harness_shared_pub'\)/);
});

test('column types match what chunk-plan-pg.ts assumes', async () => {
  const sql = await readMigration();
  const tableMatch = /CREATE TABLE IF NOT EXISTS harness_shared\.harness_chunk_plans\s*\(([\s\S]*?)\);/m.exec(sql);
  assert.ok(tableMatch);
  const body = tableMatch![1];

  // chunk-plan-pg.ts inserts files as JSONB.
  assert.match(body, /\bfiles\s+JSONB NOT NULL\b/, 'files must be JSONB NOT NULL');
  // strikes is an INT with default 0 (the DB returns 0 even when the row was just inserted).
  assert.match(body, /\bstrikes\s+INT NOT NULL DEFAULT 0\b/, 'strikes must be INT NOT NULL DEFAULT 0');
  // ts columns are bigint (epoch ms).
  assert.match(body, /\bcreated_ts\s+BIGINT NOT NULL\b/);
  assert.match(body, /\bupdated_ts\s+BIGINT NOT NULL\b/);
  // last_error / commit_sha are nullable TEXT (no NOT NULL).
  // Match TEXT followed by zero+whitespace then COMMA or close-paren — i.e. NOT followed by NOT NULL.
  assert.match(body, /\blast_error\s+TEXT\b(?!\s*NOT NULL)/);
  assert.match(body, /\bcommit_sha\s+TEXT\b(?!\s*NOT NULL)/);
});
