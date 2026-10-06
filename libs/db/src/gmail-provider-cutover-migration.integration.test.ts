/**
 * Migration 1374 — Gmail provider cutover (plan
 * generalized-integrations-google-migration-cupboard-workflows-2026-10-05, P-008 / D-020).
 *
 * Retires ONLY the legacy `system:google-gmail-poll` routine that 891 seeded. Every other routine
 * (the connector-sync driver that now syncs gmail sources included) is untouched, and the file is
 * idempotent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationSql(file: string): string {
  const armed = path.join(HERE, '..', 'sql', file);
  if (existsSync(armed)) return readFileSync(armed, 'utf8');
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return readFileSync(draft, 'utf8');
  throw new Error(`migration not found at ${armed}[.DRAFT]`);
}

const seed891 = migrationSql('891-google-gmail-poll-routine.sql');
const cutover1374 = migrationSql('1374-gmail-provider-cutover.sql');
let db: MigratedTestDb;
let sql: Sql;

async function targetRoles(): Promise<string[]> {
  const rows = await sql<{ target_role: string }[]>`SELECT target_role FROM harness_shared.routines ORDER BY target_role`;
  return rows.map((row) => row.target_role);
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'gmail1374' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA harness_shared');
  await sql.unsafe(`
    CREATE TABLE harness_shared.routines (
      id text PRIMARY KEY,
      install_slug text NOT NULL,
      workspace_id text NOT NULL,
      name text NOT NULL,
      trigger_kind text NOT NULL,
      trigger_config jsonb NOT NULL,
      target_role text NOT NULL,
      concurrency text NOT NULL,
      catchup text NOT NULL,
      active boolean NOT NULL,
      next_fire_at timestamptz,
      tier text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (install_slug, name)
    )`);
  await sql.unsafe(seed891);
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role, concurrency, catchup, active, tier)
    VALUES
      ('rt_papercusp_connector_sync', 'papercusp', 'papercusp-workspace', 'connector-sync', 'cron',
       ${sql.json({ cron: '45 * * * * *' })}, 'system:connector-sync', 'skip', 'skip', true, 'durable')`;
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1374 — Gmail provider cutover', () => {
  it('deletes the legacy Gmail poll routine and leaves the connector-sync driver alone', async () => {
    // Positive control: 891 really seeded the routine this migration retires.
    expect(await targetRoles()).toContain('system:google-gmail-poll');
    await sql.unsafe(cutover1374);
    expect(await targetRoles()).toEqual(['system:connector-sync']);
  });

  it('is idempotent', async () => {
    await sql.unsafe(cutover1374);
    expect(await targetRoles()).toEqual(['system:connector-sync']);
  });

  it('touches no data source cursor and no trigger binding (D-020)', () => {
    const statements = cutover1374
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/data_sources|trigger_bindings/i);
  });
});
