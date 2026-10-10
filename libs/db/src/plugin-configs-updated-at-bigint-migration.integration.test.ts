/**
 * Migration 1438 restores the epoch-millisecond BIGINT contract for
 * harness_shared.plugin_configs.updated_at. The baseline uses BIGINT, but
 * CREATE/ADD COLUMN IF NOT EXISTS cannot repair an older TIMESTAMPTZ column.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '../../../../test-config/src/pg.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  join(HERE, '..', 'sql', '1438-normalize-plugin-config-updated-at-bigint.sql'),
  'utf8',
);
const LEGACY_TIME = '2026-10-10T12:34:56.789Z';
const LEGACY_EPOCH_MS = Date.parse(LEGACY_TIME);
const WRITER_EPOCH_MS = LEGACY_EPOCH_MS + 1_234;

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'plugin-config-updated-at-1438' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.plugin_configs (
      harness_slug text NOT NULL,
      plugin_slug text NOT NULL,
      config jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      workspace_id text NOT NULL,
      config_ct bytea,
      CONSTRAINT plugin_configs_workspace_nonempty CHECK (workspace_id <> '')
    );
    INSERT INTO harness_shared.plugin_configs
      (harness_slug, plugin_slug, updated_at, workspace_id)
    VALUES ('legacy', 'kept', '${LEGACY_TIME}', 'ws');
  `);

  // This is the writer's exact epoch-millisecond expression. The legacy
  // TIMESTAMPTZ column rejects it with the same assignment type error as the
  // reported 42804, before the migration repairs the schema contract.
  await expect(sql.unsafe(`
    INSERT INTO harness_shared.plugin_configs
      (harness_slug, plugin_slug, updated_at, workspace_id)
    VALUES (
      'writer-before-migration',
      'epoch-ms',
      (extract(epoch FROM now()) * 1000)::bigint,
      'ws'
    );
  `)).rejects.toMatchObject({ code: '42804' });

  await sql.unsafe(MIGRATION_SQL);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1438 — plugin_configs updated_at BIGINT contract', () => {
  it('preserves legacy instants, accepts writer epoch milliseconds, and is idempotent', async () => {
    const columns = await sql<Array<{ data_type: string; column_default: string | null; is_nullable: string }>>`
      SELECT data_type, column_default, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name = 'plugin_configs'
         AND column_name = 'updated_at'`;

    expect(columns).toEqual([
      expect.objectContaining({
        data_type: 'bigint',
        is_nullable: 'NO',
      }),
    ]);
    expect(columns[0].column_default).toMatch(/0/);

    const preserved = await sql<Array<{ updated_at: string }>>`
      SELECT updated_at::text AS updated_at
        FROM harness_shared.plugin_configs
       WHERE plugin_slug = 'kept'`;
    expect(Number(preserved[0].updated_at)).toBe(LEGACY_EPOCH_MS);

    await expect(sql`
      INSERT INTO harness_shared.plugin_configs
        (harness_slug, plugin_slug, updated_at, workspace_id)
      VALUES ('writer', 'epoch-ms', ${WRITER_EPOCH_MS}::bigint, 'ws')`
    ).resolves.toBeDefined();

    await sql.unsafe(MIGRATION_SQL);
    const rows = await sql<Array<{ plugin_slug: string; updated_at: string }>>`
      SELECT plugin_slug, updated_at::text AS updated_at
        FROM harness_shared.plugin_configs
       ORDER BY plugin_slug`;
    expect(rows).toEqual([
      { plugin_slug: 'epoch-ms', updated_at: String(WRITER_EPOCH_MS) },
      { plugin_slug: 'kept', updated_at: String(LEGACY_EPOCH_MS) },
    ]);
  });
});
