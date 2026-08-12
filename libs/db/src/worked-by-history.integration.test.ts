/**
 * EI-19457370414604336 — the shared-base writer for prior-worker attribution.
 *
 * The trigger is intentionally tested at the base table because both direct
 * feature updates and engineer_issues INSTEAD-OF view updates land there.
 * This catches a future claim/release path that bypasses one compatibility
 * view, and proves remote projection churn stays out of local history.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

let db: MigratedTestDb;
let sql: Sql;

async function provision(url: string): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client.unsafe(BOOT_PREREQS_DDL);
    const { applyPendingMigrations } = (await import(pathToFileURL(RUNNER).href)) as {
      applyPendingMigrations: (o: { client: Sql; sqlDir: string }) => Promise<{ appliedCount: number; totalKnown: number }>;
    };
    const result = await applyPendingMigrations({ client, sqlDir: SQL_DIR });
    if (result.appliedCount !== result.totalKnown) {
      throw new Error(`worked-by-history provision: applied ${result.appliedCount}/${result.totalKnown}`);
    }
    // 797 is intentionally parked pending its code companion; mirror the live
    // database shape used by the adjacent engineer-issues DML integration test.
    for (const file of [
      '797-guard-engineer-issues-terminal-state.sql.PENDING-CODE-DEPLOY',
      '799-guard-797-message-self-diagnosis.sql',
      '804-fix-terminal-close-staging-remedy.sql',
      '806-work-item-worked-history.sql',
    ]) {
      await client.unsafe(await readFile(join(SQL_DIR, file), 'utf8'));
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'worked-history', provision });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

async function seed(id: string, itemKind: string, origin = 'local') {
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, payload)
    VALUES
      ('default', 'worked-history', ${id}, ${id}, 'history test', 'open', ${itemKind}, ${origin}, '{}'::jsonb)`;
}

async function history(id: string): Promise<Array<{ owner?: string; at?: string }>> {
  const rows = await sql<{ worked_by_history: Array<{ owner?: string; at?: string }> | null }[]>`
    SELECT worked_by_history FROM harness_shared.work_items
     WHERE workspace_id = 'default' AND feature_id = ${id}`;
  return rows[0]?.worked_by_history ?? [];
}

describe('migration 806 — shared-base worked_by_history writer', () => {
  it('records one owner on claim and release, but not on an idempotent same-holder update', async () => {
    await seed('WI-history-feature', 'feature');

    await sql`
      UPDATE harness_shared.work_items
         SET taken_by = 'su-history'
       WHERE workspace_id = 'default' AND feature_id = 'WI-history-feature'`;
    expect(await history('WI-history-feature')).toHaveLength(1);
    expect((await history('WI-history-feature'))[0]?.owner).toBe('su-history');

    await sql`
      UPDATE harness_shared.work_items
         SET taken_by = 'su-history', title = 'same holder'
       WHERE workspace_id = 'default' AND feature_id = 'WI-history-feature'`;
    expect(await history('WI-history-feature')).toHaveLength(1);

    await sql`
      UPDATE harness_shared.work_items
         SET taken_by = NULL
       WHERE workspace_id = 'default' AND feature_id = 'WI-history-feature'`;
    const entries = await history('WI-history-feature');
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.owner)).toEqual(['su-history', 'su-history']);
    expect(entries.every((entry) => typeof entry.at === 'string' && entry.at.length > 0)).toBe(true);
  });

  it('covers engineer_issues view writes because they land on the same base table', async () => {
    await seed('EI-history-issue', 'bug');

    await sql`
      UPDATE harness_shared.engineer_issues
         SET assignee = 'su-issue'
       WHERE workspace_id = 'default' AND issue_id = 'EI-history-issue'`;
    expect((await history('EI-history-issue')).map((entry) => entry.owner)).toEqual(['su-issue']);

    await sql`
      UPDATE harness_shared.engineer_issues
         SET assignee = NULL
       WHERE workspace_id = 'default' AND issue_id = 'EI-history-issue'`;
    expect((await history('EI-history-issue')).map((entry) => entry.owner)).toEqual(['su-issue', 'su-issue']);
  });

  it('does not turn remote projection churn into local prior-worker attribution', async () => {
    await seed('WI-history-remote', 'bug', 'remote');
    await sql`
      UPDATE harness_shared.work_items
         SET taken_by = 'peer-agent', fed_ts = 1
       WHERE workspace_id = 'default' AND feature_id = 'WI-history-remote'`;
    expect(await history('WI-history-remote')).toEqual([]);
  });
});
