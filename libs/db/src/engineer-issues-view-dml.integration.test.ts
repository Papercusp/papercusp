/**
 * engineer-issues-view-dml.integration.test.ts — EI-7490.
 *
 * Guards the `engineer_issues` compat view trigger against duplicate EI ids
 * introduced by federation. Ordinary UPDATEs must not normalize a legacy
 * empty-slug operator row onto `operator:<workspace>` and collide with an
 * existing local row.
 *
 * Real Postgres (testcontainer; Docker required). Run:
 *   cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts \
 *     src/engineer-issues-view-dml.integration.test.ts
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

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (o: { client: Sql; sqlDir: string }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const { appliedCount, totalKnown } = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    if (appliedCount !== totalKnown) {
      throw new Error(`engineer-issues-view-dml provision: applied ${appliedCount}/${totalKnown}`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'eidml', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

async function seedDuplicateIssueRows(issueId: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status,
       item_kind, origin, ts, created_ts, updated_ts, payload)
    VALUES
      ('ws1', '', ${issueId}, 'remote replication signal', 'remote body', 'open',
       'bug', 'remote', 1000, 1000, 1000,
       '{"_ei":{"scope":"operator","severity":"major","source":"engineer","created_by":"system:replication-liveness"}}'::jsonb),
      ('ws1', 'operator:ws1', ${issueId}, 'local improvement', 'local body', 'open',
       'change', 'local', 2000, 2000, 2000,
       '{"_ei":{"scope":"operator","severity":"minor","source":"su","created_by":"su-test"}}'::jsonb)`;
}

describe('engineer_issues view DML duplicate-id targeting', () => {
  it('updates duplicate logical issue ids without pkey collision, row collapse, or remote mutation', async () => {
    const issueId = 'EI-900001';
    await seedDuplicateIssueRows(issueId);

    await sql`
      UPDATE harness_shared.engineer_issues
         SET payload = COALESCE(payload, '{}'::jsonb) || '{"touched":true}'::jsonb,
             body = body || ' touched'
       WHERE workspace_id = 'ws1' AND issue_id = ${issueId}`;

    const rows = await sql<{ harness_slug: string; origin: string; summary: string; touched: boolean | null }[]>`
      SELECT harness_slug, origin, summary, (payload->>'touched')::boolean AS touched
        FROM harness_shared.work_items
       WHERE workspace_id = 'ws1' AND feature_id = ${issueId}
       ORDER BY harness_slug, origin`;

    expect(rows).toEqual([
      { harness_slug: '', origin: 'remote', summary: 'remote body', touched: null },
      { harness_slug: 'operator:ws1', origin: 'local', summary: 'local body touched', touched: true },
    ]);
  });

  it('does not mutate a remote physical row even when the view UPDATE targets it', async () => {
    const issueId = 'EI-900002';
    await seedDuplicateIssueRows(issueId);

    await sql`
      UPDATE harness_shared.engineer_issues
         SET scope = 'harness:remote-peer'
       WHERE workspace_id = 'ws1'
         AND issue_id = ${issueId}
         AND origin = 'remote'
         AND base_harness_slug = ''`;

    const rows = await sql<{ harness_slug: string; origin: string; scope: string; summary: string }[]>`
      SELECT wi.harness_slug, wi.origin, ei.scope, wi.summary
        FROM harness_shared.work_items wi
        JOIN harness_shared.engineer_issues ei
          ON ei.workspace_id = wi.workspace_id
         AND ei.issue_id = wi.feature_id
         AND ei.origin = wi.origin
         AND ei.base_harness_slug = wi.harness_slug
       WHERE wi.workspace_id = 'ws1' AND wi.feature_id = ${issueId}
       ORDER BY wi.harness_slug, wi.origin`;

    expect(rows).toEqual([
      { harness_slug: '', origin: 'remote', scope: 'operator', summary: 'remote body' },
      { harness_slug: 'operator:ws1', origin: 'local', scope: 'operator', summary: 'local body' },
    ]);
  });
});
