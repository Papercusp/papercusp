/**
 * Migration 949 regression coverage for EI-21399888205771088.
 *
 * coord_presence answers live state only and is TTL-reaped. The schema
 * comments are a guard at the query boundary: a future agent inspecting the
 * table gets an explicit warning that absence cannot prove historical absence.
 * This test applies the real migration to an existing table and re-applies it
 * to prove the metadata-only migration is safe to run more than once.
 *
 * Run:
 *   npm run test:integration -- src/coord-presence-state-only-migration.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(join(HERE, '..', 'sql', '949-coord-presence-state-only-contract.sql'), 'utf8');

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'presence949' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.coord_presence (
      owner_id text NOT NULL PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default',
      heartbeat_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

async function readComments(): Promise<{
  tableComment: string | null;
  ownerComment: string | null;
  heartbeatComment: string | null;
}> {
  const [row] = await sql<{
    table_comment: string | null;
    owner_comment: string | null;
    heartbeat_comment: string | null;
  }[]>`
    SELECT
      obj_description('harness_shared.coord_presence'::regclass, 'pg_class') AS table_comment,
      (
        SELECT col_description('harness_shared.coord_presence'::regclass, attnum)
          FROM pg_attribute
         WHERE attrelid = 'harness_shared.coord_presence'::regclass
           AND attname = 'owner_id'
      ) AS owner_comment,
      (
        SELECT col_description('harness_shared.coord_presence'::regclass, attnum)
          FROM pg_attribute
         WHERE attrelid = 'harness_shared.coord_presence'::regclass
           AND attname = 'heartbeat_at'
      ) AS heartbeat_comment
  `;
  return {
    tableComment: row?.table_comment ?? null,
    ownerComment: row?.owner_comment ?? null,
    heartbeatComment: row?.heartbeat_comment ?? null,
  };
}

describe('migration 949 — coord_presence state-only contract', () => {
  it('documents TTL reaping and the non-historical meaning of absence', async () => {
    await sql.unsafe(MIGRATION_SQL);
    const comments = await readComments();

    expect(comments.tableComment).toContain('TTL-reaped');
    expect(comments.tableComment).toContain('absence means reaped or never-present');
    expect(comments.ownerComment).toContain('not evidence');
    expect(comments.heartbeatComment).toContain('not a historical presence record');
  });

  it('is idempotent and preserves the contract', async () => {
    await sql.unsafe(MIGRATION_SQL);
    const comments = await readComments();

    expect(comments.tableComment).toContain('append-only event/history records');
    expect(comments.ownerComment).toContain('coord_presence is TTL-reaped');
    expect(comments.heartbeatComment).toContain('rows are TTL-reaped after inactivity');
  });
});
