/**
 * Migration 1077 — guarded retirement of legacy governor work-item receipts.
 *
 * Applies the real parked migration to a minimal cross-version schema in real
 * PostgreSQL. The rig proves every unsafe precondition rolls back without
 * changing rows or schema, then pins the terminal delete and representation
 * cleanup at the serialized retired-writer edge.
 *
 * Run:
 *   npm run test:integration -- src/resource-governor-work-item-receipt-retirement.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(HERE, '..', 'sql');

function readMigration(name: string): string {
  const armed = join(SQL_DIR, name);
  if (existsSync(armed)) return readFileSync(armed, 'utf8');
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return readFileSync(draft, 'utf8');
  throw new Error(`migration ${name} not found at ${armed}[.DRAFT]`);
}

const LEDGER_SQL = readMigration('1062-resource-governor-admission-ledger.sql');
const OVERLAP_SQL = readMigration('1067-resource-governor-cutover-collision-guard.sql');
const RETIRED_WRITER_SQL = readMigration('1076-resource-governor-retired-writer-guard.sql');
const RETIREMENT_SQL = readMigration('1077-resource-governor-work-item-receipt-retirement.sql');

let db: MigratedTestDb;
let sql: Sql;

function ledgerRecord(): Record<string, unknown> {
  const now = 100_000;
  return {
    schemaVersion: 1,
    namespace: 'retirement-test',
    idempotencyKey: 'ledger-positive-control',
    requestFingerprint: 'f'.repeat(64),
    admissionClass: 'process',
    priority: 1,
    deadlineAtMs: null,
    demand: { cpuWeight: 1 },
    payloadRef: null,
    coalesceKey: null,
    metadata: {},
    context: {
      contractVersion: 1,
      requestId: 'ledger-positive-control',
      rootRequestId: 'ledger-positive-control',
      parentRequestId: null,
      parentReceiptId: null,
      idempotencyKey: 'ledger-positive-control',
      admissionClass: 'process',
      priority: 1,
      demand: { cpuWeight: 1 },
      depth: 0,
      createdAtMs: now,
      decisionGeneration: 0,
    },
    state: 'completed',
    enqueuedAtMs: now,
    updatedAtMs: now,
    decision: { generation: 1, atMs: now, reason: 'completed', evidence: {} },
    resultRef: 'result:positive-control',
  };
}

function legacyRecord(state: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    namespace: 'retirement-test',
    idempotencyKey: `legacy-${state}`,
    requestFingerprint: `${state}-fingerprint`,
    admissionClass: 'process',
    state,
    enqueuedAtMs: 1_000,
    updatedAtMs: 1_500,
    decision: { generation: 1, atMs: 1_500, reason: state },
  };
}

async function applyRetirement(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(RETIREMENT_SQL);
  });
}

async function legacyCount(): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
      FROM harness_shared.work_items
     WHERE jsonb_exists(COALESCE(payload, '{}'::jsonb), 'resource_governor')`;
  return Number(row.count);
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'governor1077' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });

  await sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE harness_shared.operator_settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      description text,
      updated_at bigint NOT NULL DEFAULT 0,
      workspace_id text
    );
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      feature_id text NOT NULL,
      payload jsonb,
      status text,
      taken_by text,
      created_ts bigint,
      updated_ts bigint,
      PRIMARY KEY (workspace_id, feature_id)
    );
    CREATE UNIQUE INDEX work_items_resource_governor_identity_uq
      ON harness_shared.work_items (
        workspace_id,
        ((payload->'resource_governor')->>'namespace'),
        ((payload->'resource_governor')->>'idempotencyKey')
      )
      WHERE (payload->'resource_governor'->>'schemaVersion') = '1';
    CREATE INDEX work_items_resource_governor_queue_idx
      ON harness_shared.work_items (
        workspace_id,
        ((payload->'resource_governor')->>'namespace'),
        ((payload->'resource_governor')->>'state'),
        created_ts,
        feature_id
      )
      WHERE (payload->'resource_governor'->>'schemaVersion') = '1';
  `);

  await sql.unsafe(LEDGER_SQL);
  await sql.unsafe(OVERLAP_SQL);
  await sql.unsafe(RETIRED_WRITER_SQL);

  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, feature_id, payload, status, created_ts, updated_ts)
    VALUES
      (
        'ws-retirement',
        'WI-terminal',
        ${JSON.stringify({ resource_governor: legacyRecord('completed') })}::text::jsonb,
        'done',
        1000,
        1500
      ),
      (
        'ws-retirement',
        'WI-active',
        ${JSON.stringify({ resource_governor: legacyRecord('running') })}::text::jsonb,
        'wip',
        1500,
        1500
      ),
      (
        'ws-retirement',
        'WI-ordinary',
        ${JSON.stringify({ title: 'ordinary work survives' })}::text::jsonb,
        'open',
        1000,
        1000
      )`;

  await sql`
    INSERT INTO harness_shared.resource_governor_admissions (workspace_id, record)
    VALUES ('ws-retirement', ${JSON.stringify(ledgerRecord())}::text::jsonb)`;

  await sql`
    INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
    VALUES
      (
        'resource_governor_admission_ledger_cutover:ws-retirement',
        '1',
        'ledger positive control',
        1900,
        'ws-retirement'
      ),
      (
        'resource_governor_admission_legacy_writers_retired:ws-retirement',
        '1',
        'serialized retired-writer edge',
        2000,
        'ws-retirement'
      )`;
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1077 — resource-governor work-item receipt retirement', () => {
  it('rolls back while a non-terminal or unknown-state legacy receipt remains', async () => {
    await expect(applyRetirement()).rejects.toThrow(/non-terminal, malformed, or unknown-state legacy receipt/);
    expect(await legacyCount()).toBe(2);

    const [artifacts] = await sql<{ indexes: number; triggers: number }[]>`
      SELECT
        (SELECT count(*)::int FROM pg_indexes
          WHERE schemaname = 'harness_shared'
            AND indexname IN (
              'work_items_resource_governor_identity_uq',
              'work_items_resource_governor_queue_idx'
            )) AS indexes,
        (SELECT count(*)::int FROM pg_trigger
          WHERE tgrelid = 'harness_shared.work_items'::regclass
            AND tgname = 'reject_post_cutover_governor_work_item_trg'
            AND NOT tgisinternal) AS triggers`;
    expect(artifacts).toEqual({ indexes: 2, triggers: 1 });
  });

  it('rolls back when a governed workspace lacks the explicit retirement marker', async () => {
    await sql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(payload, '{resource_governor,state}', '"completed"'::jsonb),
             status = 'done'
       WHERE workspace_id = 'ws-retirement'
         AND feature_id = 'WI-active'`;
    await sql`
      DELETE FROM harness_shared.operator_settings
       WHERE key = 'resource_governor_admission_legacy_writers_retired:ws-retirement'`;

    await expect(applyRetirement()).rejects.toThrow(/lack the serialized retired-writer marker/);
    expect(await legacyCount()).toBe(2);

    await sql`
      INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
      VALUES (
        'resource_governor_admission_legacy_writers_retired:ws-retirement',
        '1',
        'serialized retired-writer edge',
        2000,
        'ws-retirement'
      )`;
  });

  it('rolls back when a legacy receipt cannot be ordered before retirement', async () => {
    await sql`
      UPDATE harness_shared.work_items
         SET created_ts = 2500
       WHERE workspace_id = 'ws-retirement'
         AND feature_id = 'WI-terminal'`;

    await expect(applyRetirement()).rejects.toThrow(/created after .* retired-writer marker/);
    expect(await legacyCount()).toBe(2);

    await sql`
      UPDATE harness_shared.work_items
         SET created_ts = 1000
       WHERE workspace_id = 'ws-retirement'
         AND feature_id = 'WI-terminal'`;
  });

  it('deletes only terminal legacy receipts and retires representation-specific schema', async () => {
    await applyRetirement();

    expect(await legacyCount()).toBe(0);
    const [result] = await sql<
      {
        ordinary: number;
        ledger: number;
        old_indexes: number;
        old_triggers: number;
        old_functions: number;
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM harness_shared.work_items
          WHERE workspace_id = 'ws-retirement' AND feature_id = 'WI-ordinary') AS ordinary,
        (SELECT count(*)::int FROM harness_shared.resource_governor_admissions
          WHERE workspace_id = 'ws-retirement') AS ledger,
        (SELECT count(*)::int FROM pg_indexes
          WHERE schemaname = 'harness_shared'
            AND indexname IN (
              'work_items_resource_governor_identity_uq',
              'work_items_resource_governor_queue_idx'
            )) AS old_indexes,
        (SELECT count(*)::int FROM pg_trigger
          WHERE tgrelid = 'harness_shared.work_items'::regclass
            AND tgname = 'reject_post_cutover_governor_work_item_trg'
            AND NOT tgisinternal) AS old_triggers,
        (SELECT count(*)::int FROM pg_proc
          WHERE oid = to_regprocedure('harness_shared.reject_post_cutover_governor_work_item()')) AS old_functions`;

    expect(result).toEqual({
      ordinary: 1,
      ledger: 1,
      old_indexes: 0,
      old_triggers: 0,
      old_functions: 0,
    });
  });

  it('is idempotent after the zero-legacy postcondition is established', async () => {
    await expect(applyRetirement()).resolves.toBeUndefined();
    expect(await legacyCount()).toBe(0);
  });
});
