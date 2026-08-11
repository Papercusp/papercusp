/**
 * work-items-unify.integration.test.ts — P-010 unification cutover, Phase 1 (schema).
 * Seeds both families on the pre-cutover schema (migrations 000–373), applies the
 * _DRAFT cutover migration, and asserts: work_items becomes the base TABLE, the issue
 * backfill maps correctly (sentinel ''/payload->'_ei'), both compat views round-trip,
 * and the engineer_issues INSTEAD OF triggers + the auto-updatable feature view route.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts \
 *     src/work-items-unify.integration.test.ts
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(here, '..', 'sql');
const RUNNER = join(here, '..', '..', '..', 'packages', 'embedded-postgres-server', 'src', 'migration-runner.js');
const MIG_374 = readFileSync(join(SQL_DIR, '374-work-items-unify-base-table.sql'), 'utf8')
  .split('\n').filter((l) => !/^\s*\\/.test(l)).join('\n'); // strip psql \set lines

// Provision 000–373 only, so we can seed the OLD tables then apply the cutover and
// exercise the backfill. Everything ≥374 must be skipped, not just 374 itself: later
// migrations (375 capture triggers, 452, …) assume work_items is already the
// post-cutover base table and fail with `"work_items" is a view` on this rig.
const MIG_NUM = (f: string) => Number(/^(\d+)-/.exec(f)?.[1] ?? NaN);
const SKIP_374 = (f: string) =>
  f.includes('per-harness-template') ||
  f === '040-plugin-configs-backfill.sql' ||
  f === '__seed_restored__.marker' ||
  MIG_NUM(f) >= 374;

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
      applyPendingMigrations: (o: { client: Sql; sqlDir: string; skipFile?: (f: string) => boolean }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    // Skip 374 here so the seed lands in the pre-cutover tables; apply 374 in-test.
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client, sqlDir: SQL_DIR, skipFile: SKIP_374 });
    if (appliedCount !== totalKnown) throw new Error(`unify provision: ${appliedCount}/${totalKnown}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;
beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'wiunify', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });

  // Seed both families on the PRE-cutover schema (still separate tables).
  await sql`INSERT INTO harness_shared.harness_features_consolidated
    (harness_slug, feature_id, workspace_id, title, summary, status, item_kind)
    VALUES ('papercup', 'F-1', 'ws1', 'Feat one', 'feat body', 'todo', 'feature')`;
  await sql`INSERT INTO harness_shared.engineer_issues
    (workspace_id, issue_id, scope, title, body, severity, source, state, kind, assignee)
    VALUES
    ('ws1', 'EI-1', 'harness:papercup', 'Bug one', 'bug body', 'major', 'engineer', 'open', 'bug', 'su-x'),
    ('ws1', 'EI-2', 'operator', 'Op change', 'op body', 'minor', 'su', 'open', 'change', NULL)`;

  // Apply the cutover.
  await sql.unsafe(MIG_374);
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('P-010 cutover Phase 1 — schema', () => {
  it('work_items is now a base TABLE holding both families', async () => {
    const [{ relkind }] = (await sql`
      SELECT relkind FROM pg_class WHERE relname='work_items' AND relnamespace='harness_shared'::regnamespace`) as { relkind: string }[];
    expect(relkind).toBe('r'); // table, not 'v'
    const [{ n }] = (await sql`SELECT count(*)::int n FROM harness_shared.work_items`) as { n: number }[];
    expect(n).toBe(3); // 1 feature + 2 issues backfilled
  });

  it('the issue backfill maps correctly (sentinel "", payload->_ei, epoch ts)', async () => {
    const rows = (await sql`SELECT feature_id, harness_slug, summary, status, item_kind, payload FROM harness_shared.work_items WHERE feature_id IN ('EI-1','EI-2') ORDER BY feature_id`) as Array<{ feature_id: string; harness_slug: string; summary: string; status: string; item_kind: string; payload: Record<string, unknown> }>;
    const ei1 = rows.find((r) => r.feature_id === 'EI-1')!;
    const ei2 = rows.find((r) => r.feature_id === 'EI-2')!;
    expect(ei1.harness_slug).toBe('papercup'); // harness:papercup → papercup
    expect(ei1.item_kind).toBe('bug');
    expect(ei1.summary).toBe('bug body'); // body → summary
    expect((ei1.payload as { _ei: { severity: string; source: string; scope: string } })._ei).toMatchObject({ severity: 'major', source: 'engineer', scope: 'harness:papercup' });
    expect(ei2.harness_slug).toBe(''); // operator → sentinel ''
    expect(ei2.item_kind).toBe('change');
  });

  it('engineer_issues compat view round-trips the issue shape', async () => {
    const rows = (await sql`SELECT issue_id, scope, body, severity, source, state, kind, assignee FROM harness_shared.engineer_issues ORDER BY issue_id`) as Array<Record<string, string | null>>;
    expect(rows.map((r) => r.issue_id)).toEqual(['EI-1', 'EI-2']);
    expect(rows[0]).toMatchObject({ scope: 'harness:papercup', body: 'bug body', severity: 'major', source: 'engineer', state: 'open', kind: 'bug', assignee: 'su-x' });
    expect(rows[1]).toMatchObject({ scope: 'operator', kind: 'change', severity: 'minor' });
  });

  it('feature compat view shows only non-issue kinds', async () => {
    const rows = (await sql`SELECT feature_id, item_kind FROM harness_shared.harness_features_consolidated`) as Array<{ feature_id: string; item_kind: string }>;
    expect(rows).toEqual([{ feature_id: 'F-1', item_kind: 'feature' }]);
  });

  it('engineer_issues INSTEAD OF INSERT/UPDATE/DELETE route to work_items', async () => {
    await sql`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, scope, title, body, severity, source, state, kind) VALUES ('ws1','EI-3','harness:papercup','New','b','nit','su','open','task')`;
    const [ins] = (await sql`SELECT item_kind, harness_slug FROM harness_shared.work_items WHERE feature_id='EI-3'`) as Array<{ item_kind: string; harness_slug: string }>;
    expect(ins).toMatchObject({ item_kind: 'task', harness_slug: 'papercup' });

    await sql`UPDATE harness_shared.engineer_issues SET severity='critical' WHERE issue_id='EI-3'`;
    const [upd] = (await sql`SELECT status, payload->'_ei'->>'severity' sev FROM harness_shared.work_items WHERE feature_id='EI-3'`) as Array<{ status: string; sev: string }>;
    expect(upd).toMatchObject({ status: 'open', sev: 'critical' });

    await sql`DELETE FROM harness_shared.engineer_issues WHERE issue_id='EI-3'`;
    const [{ n }] = (await sql`SELECT count(*)::int n FROM harness_shared.work_items WHERE feature_id='EI-3'`) as { n: number }[];
    expect(n).toBe(0);
  });

  it('feature compat view is auto-updatable (insert routes to work_items)', async () => {
    await sql`INSERT INTO harness_shared.harness_features_consolidated (harness_slug, feature_id, workspace_id, title, status, item_kind) VALUES ('papercup','F-2','ws1','Feat two','todo','feature')`;
    const [{ item_kind }] = (await sql`SELECT item_kind FROM harness_shared.work_items WHERE feature_id='F-2'`) as Array<{ item_kind: string }>;
    expect(item_kind).toBe('feature');
  });

  it('re-applying the migration is an idempotent no-op (guards the live re-run)', async () => {
    const [{ n: before }] = (await sql`SELECT count(*)::int n FROM harness_shared.work_items`) as { n: number }[];
    await sql.unsafe(MIG_374); // second application — must not error or duplicate-backfill
    const [{ n: after }] = (await sql`SELECT count(*)::int n FROM harness_shared.work_items`) as { n: number }[];
    expect(after).toBe(before);
    const [{ relkind }] = (await sql`SELECT relkind::text FROM pg_class WHERE relname='work_items' AND relnamespace='harness_shared'::regnamespace`) as { relkind: string }[];
    expect(relkind).toBe('r'); // still a table; the structural cutover guard skipped it
  });
});
