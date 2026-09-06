/**
 * EI-22466530310361606 — migration 1135 guards work-item epoch-ms units.
 *
 * The production fixture deliberately omits CHECK constraints, so this migration
 * test uses the smallest work_items table shape needed to exercise the database
 * contract directly. The guard is NOT VALID to preserve legacy bad rows during
 * rollout, but PostgreSQL enforces it on all new inserts and updates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = join(HERE, '..', 'sql', '1135-work-items-epoch-ms-timestamp-guard.sql');
const MIGRATION_SQL = readFileSync(
  existsSync(MIGRATION_PATH) ? MIGRATION_PATH : `${MIGRATION_PATH}.DRAFT`,
  'utf8',
);

const EPOCH_MS = 1_788_261_281_896;
const EPOCH_SECONDS = 1_788_278_475;
const NINE_DIGIT = 999_999_999;

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'wi-epoch-ms-1135' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });

  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      created_ts bigint,
      updated_ts bigint,
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
    );

    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, created_ts, updated_ts)
    VALUES
      ('ws', 'papercusp', 'valid',         ${EPOCH_MS},     ${EPOCH_MS}),
      ('ws', 'papercusp', 'bad-created',   ${EPOCH_SECONDS}, ${EPOCH_MS}),
      ('ws', 'papercusp', 'bad-updated',   ${EPOCH_MS},     ${EPOCH_SECONDS}),
      ('ws', 'papercusp', 'small-positive', ${NINE_DIGIT}, ${NINE_DIGIT});
  `);

  await sql.unsafe(MIGRATION_SQL);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1135 — work_items epoch-ms timestamp units', () => {
  it('installs one NOT VALID check that names both timestamp columns and the ten-digit range', async () => {
    const [constraint] = await sql<
      Array<{ convalidated: boolean; definition: string }>
    >`
      SELECT convalidated, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'harness_shared.work_items'::regclass
         AND conname = 'work_items_epoch_ms_timestamp_units_chk'`;

    expect(constraint).toMatchObject({ convalidated: false });
    expect(constraint?.definition).toMatch(/created_ts/);
    expect(constraint?.definition).toMatch(/updated_ts/);
    expect(constraint?.definition).toMatch(/1000000000/);
    expect(constraint?.definition).toMatch(/10000000000/);

    const legacyRows = await sql<{ feature_id: string }[]>`
      SELECT feature_id
        FROM harness_shared.work_items
       WHERE feature_id IN ('bad-created', 'bad-updated')
       ORDER BY feature_id`;
    expect(legacyRows).toEqual([
      { feature_id: 'bad-created' },
      { feature_id: 'bad-updated' },
    ]);
  });

  it('rejects epoch-seconds on INSERT for either timestamp column', async () => {
    await expect(sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, created_ts, updated_ts)
      VALUES ('ws', 'papercusp', 'insert-bad-created', ${EPOCH_SECONDS}, ${EPOCH_MS})`
    ).rejects.toThrow(/work_items_epoch_ms_timestamp_units_chk/);

    await expect(sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, created_ts, updated_ts)
      VALUES ('ws', 'papercusp', 'insert-bad-updated', ${EPOCH_MS}, ${EPOCH_SECONDS})`
    ).rejects.toThrow(/work_items_epoch_ms_timestamp_units_chk/);
  });

  it('rejects epoch-seconds on UPDATE while allowing values outside the ten-digit range', async () => {
    await expect(sql`
      UPDATE harness_shared.work_items
         SET created_ts = ${EPOCH_SECONDS}
       WHERE feature_id = 'valid'`
    ).rejects.toThrow(/work_items_epoch_ms_timestamp_units_chk/);

    await expect(sql`
      UPDATE harness_shared.work_items
         SET updated_ts = ${EPOCH_SECONDS}
       WHERE feature_id = 'valid'`
    ).rejects.toThrow(/work_items_epoch_ms_timestamp_units_chk/);

    await expect(sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, created_ts, updated_ts)
      VALUES ('ws', 'papercusp', 'insert-small', ${NINE_DIGIT}, ${NINE_DIGIT})`
    ).resolves.toBeDefined();

    await expect(sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, created_ts, updated_ts)
      VALUES ('ws', 'papercusp', 'insert-ms', ${EPOCH_MS}, ${EPOCH_MS})`
    ).resolves.toBeDefined();
  });

  it('is idempotent when the migration is applied again', async () => {
    await expect(sql.unsafe(MIGRATION_SQL)).resolves.not.toThrow();

    const constraints = await sql<{ conname: string }[]>`
      SELECT conname
        FROM pg_constraint
       WHERE conrelid = 'harness_shared.work_items'::regclass
         AND conname = 'work_items_epoch_ms_timestamp_units_chk'`;
    expect(constraints).toEqual([
      { conname: 'work_items_epoch_ms_timestamp_units_chk' },
    ]);
  });
});
