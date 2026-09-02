/**
 * Migration 1062 — dedicated resource-governor admission ledger.
 *
 * Applies the real migration to a minimal pre-cutover schema in real PostgreSQL.
 * The rig pins the purpose-built identity/state/index boundary and the dormant
 * cross-version guard without replaying the full migration chain.
 *
 * Run:
 *   npm run test:integration -- src/resource-governor-admission-ledger-migration.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = join(HERE, '..', 'sql', '1062-resource-governor-admission-ledger.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 1062 not found at ${armed}[.DRAFT]`);
}

const MIGRATION_SQL = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = 1_788_246_000_000;
  return {
    schemaVersion: 1,
    namespace: 'migration-test',
    idempotencyKey: 'request-a',
    requestFingerprint: 'f'.repeat(64),
    admissionClass: 'process',
    priority: 3,
    deadlineAtMs: null,
    demand: { cpuWeight: 1 },
    payloadRef: null,
    coalesceKey: null,
    metadata: {},
    context: {
      contractVersion: 1,
      requestId: 'request-a',
      rootRequestId: 'request-a',
      parentRequestId: null,
      parentReceiptId: null,
      idempotencyKey: 'request-a',
      admissionClass: 'process',
      priority: 3,
      demand: { cpuWeight: 1 },
      depth: 0,
      createdAtMs: now,
      decisionGeneration: 0,
    },
    state: 'queued',
    enqueuedAtMs: now,
    updatedAtMs: now,
    decision: { generation: 0, atMs: now, reason: 'persisted', evidence: {} },
    ...overrides,
  };
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'governor1062' });
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
  `);
  await sql.unsafe(MIGRATION_SQL);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1062 — resource-governor admission ledger', () => {
  it('generates a non-work opaque identity and projects canonical record fields', async () => {
    const [row] = await sql<{
      receipt_id: string;
      schema_version: number;
      namespace: string;
      idempotency_key: string;
      admission_class: string;
      state: string;
      priority: number;
      enqueued_at_ms: string;
      updated_at_ms: string;
    }[]>`
      INSERT INTO harness_shared.resource_governor_admissions (workspace_id, record)
      VALUES ('ws-identity', ${JSON.stringify(record())}::text::jsonb)
      RETURNING receipt_id, schema_version, namespace, idempotency_key,
                admission_class, state, priority, enqueued_at_ms, updated_at_ms`;

    expect(row.receipt_id).toMatch(
      /^RG-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(row.receipt_id).not.toMatch(/^(?:WI|EI|F)-/);
    expect({
      schemaVersion: row.schema_version,
      namespace: row.namespace,
      idempotencyKey: row.idempotency_key,
      admissionClass: row.admission_class,
      state: row.state,
      priority: Number(row.priority),
      enqueuedAtMs: Number(row.enqueued_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
    }).toEqual({
      schemaVersion: 1,
      namespace: 'migration-test',
      idempotencyKey: 'request-a',
      admissionClass: 'process',
      state: 'queued',
      priority: 3,
      enqueuedAtMs: 1_788_246_000_000,
      updatedAtMs: 1_788_246_000_000,
    });
  });

  it('enforces workspace/namespace/idempotency uniqueness under a distinct receipt identity', async () => {
    const first = record({ idempotencyKey: 'same-key' });
    await sql`
      INSERT INTO harness_shared.resource_governor_admissions (workspace_id, record)
      VALUES ('ws-unique', ${JSON.stringify(first)}::text::jsonb)`;

    await expect(sql`
      INSERT INTO harness_shared.resource_governor_admissions (workspace_id, record)
      VALUES (
        'ws-unique',
        ${JSON.stringify({ ...first, requestFingerprint: 'e'.repeat(64) })}::text::jsonb
      )
    `).rejects.toThrow(/resource_governor_admissions_identity_uq/);

    await expect(sql`
      INSERT INTO harness_shared.resource_governor_admissions (workspace_id, record)
      VALUES ('ws-unique-other', ${JSON.stringify(first)}::text::jsonb)
    `).resolves.toBeDefined();
  });

  it('rejects work-item identities and malformed lease state', async () => {
    await expect(sql`
      INSERT INTO harness_shared.resource_governor_admissions (workspace_id, receipt_id, record)
      VALUES ('ws-invalid', 'WI-123', ${JSON.stringify(record({ idempotencyKey: 'bad-id' }))}::text::jsonb)
    `).rejects.toThrow(/resource_governor_admissions_receipt_id_chk/);

    await expect(sql`
      INSERT INTO harness_shared.resource_governor_admissions (workspace_id, record)
      VALUES (
        'ws-invalid',
        ${JSON.stringify(record({ idempotencyKey: 'bad-lease', state: 'running' }))}::text::jsonb
      )
    `).rejects.toThrow(/resource_governor_admissions_lease_chk/);
  });

  it('installs selective queue, coalesce, lease, expiry, and retention indexes', async () => {
    const indexes = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef
        FROM pg_indexes
       WHERE schemaname = 'harness_shared'
         AND tablename = 'resource_governor_admissions'
       ORDER BY indexname`;
    const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));

    expect([...byName.keys()]).toEqual(expect.arrayContaining([
      'resource_governor_admissions_identity_uq',
      'resource_governor_admissions_active_queue_idx',
      'resource_governor_admissions_active_coalesce_idx',
      'resource_governor_admissions_active_lease_idx',
      'resource_governor_admissions_pending_expiry_idx',
      'resource_governor_admissions_terminal_retention_idx',
    ]));
    for (const name of [
      'resource_governor_admissions_active_queue_idx',
      'resource_governor_admissions_active_coalesce_idx',
      'resource_governor_admissions_active_lease_idx',
      'resource_governor_admissions_pending_expiry_idx',
      'resource_governor_admissions_terminal_retention_idx',
    ]) {
      expect(byName.get(name)).toContain(' WHERE ');
    }
  });

  it('keeps the legacy insert guard dormant until cutover, then blocks only new governor receipts', async () => {
    await sql`
      INSERT INTO harness_shared.work_items (workspace_id, feature_id, payload, status)
      VALUES ('ws-cutover', 'WI-legacy-before', ${sql.json({ resource_governor: { schemaVersion: 1, state: 'running' } })}::jsonb, 'wip')`;

    await sql`
      INSERT INTO harness_shared.operator_settings (key, value, description, updated_at, workspace_id)
      VALUES (
        'resource_governor_admission_ledger_cutover:ws-cutover',
        '1',
        'migration test',
        1788246000000,
        'ws-cutover'
      )`;

    await expect(sql`
      INSERT INTO harness_shared.work_items (workspace_id, feature_id, payload, status)
      VALUES ('ws-cutover', 'WI-legacy-after', ${sql.json({ resource_governor: { schemaVersion: 1 } })}::jsonb, 'open')
    `).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'work_items_resource_governor_post_cutover_guard',
      message: expect.stringContaining('legacy work_items receipt insertion is disabled'),
    });

    await expect(sql`
      INSERT INTO harness_shared.work_items (workspace_id, feature_id, payload, status)
      VALUES ('ws-cutover', 'WI-real-work', ${sql.json({ title: 'ordinary work' })}::jsonb, 'open')
    `).resolves.toBeDefined();

    await expect(sql`
      UPDATE harness_shared.work_items
         SET payload = ${sql.json({ resource_governor: { schemaVersion: 1, state: 'completed' } })}::jsonb,
             status = 'done'
       WHERE workspace_id = 'ws-cutover'
         AND feature_id = 'WI-legacy-before'
    `).resolves.toBeDefined();
  });

  it('is idempotent and preserves the cutover guard on reapply', async () => {
    await sql.unsafe(MIGRATION_SQL);
    const [row] = await sql<{ trigger_count: number; table_comment: string }[]>`
      SELECT
        (
          SELECT count(*)::int
            FROM pg_trigger
           WHERE tgrelid = 'harness_shared.work_items'::regclass
             AND tgname = 'reject_post_cutover_governor_work_item_trg'
             AND NOT tgisinternal
        ) AS trigger_count,
        obj_description('harness_shared.resource_governor_admissions'::regclass, 'pg_class') AS table_comment`;

    expect(Number(row.trigger_count)).toBe(1);
    expect(row.table_comment).toContain('not work');
  });
});
