/**
 * Migration 876 — canonical external-trigger core.
 *
 * Runs the real migration against fresh Postgres and exercises the invariants
 * that later adapters and the binding engine rely on: plan/source FKs,
 * canonical datatype references, per-sink delivery dedupe, run idempotency,
 * idempotent DDL, and workspace RLS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '876-external-trigger-core.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 876 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;
let sourceId: string;
let bindingId: string;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'triggers876' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA harness_shared');
  await sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.datatype_registry (
      workspace_id text NOT NULL,
      id text NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug)
    VALUES ('ws-a', 'papercusp', 'inbox-triage');
    INSERT INTO harness_shared.datatype_registry (workspace_id, id)
    VALUES ('ws-a', 'email-message');
  `);
  await sql.unsafe(migrationSql);

  const [source] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.trigger_sources
      (workspace_id, kind, credential_ref, status, cursor)
    VALUES (
      'ws-a', 'gmail', 'google-workspace:owner', 'connected',
      ${sql.json({ historyId: '1234' })}
    )
    RETURNING id`;
  sourceId = source.id;

  const [binding] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.trigger_bindings
      (workspace_id, source_id, plan_harness_slug, plan_slug,
       event_pattern, action, armed, storm_policy)
    VALUES (
      'ws-a', ${sourceId}, 'papercusp', 'inbox-triage',
      'ext:gmail.message.received', ${sql.json({ type: 'run-plan' })}, true,
      ${sql.json({ mode: 'coalesce', windowSeconds: 60 })}
    )
    RETURNING id`;
  bindingId = binding.id;
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 876 — external trigger core', () => {
  it('is idempotent and creates all four trigger tables', async () => {
    await sql.unsafe(migrationSql);
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'harness_shared'
         AND table_name LIKE 'trigger_%'
       ORDER BY table_name`;
    expect(rows.map((row) => row.table_name)).toEqual([
      'trigger_bindings',
      'trigger_deliveries',
      'trigger_runs',
      'trigger_sources',
    ]);
  });

  it('binds only existing sources and plans without copying plan classification', async () => {
    await expect(sql`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern)
      VALUES ('ws-a', ${sourceId}, 'papercusp', 'missing-plan', 'ext:test')
    `).rejects.toThrow(/trigger_bindings_plan_fk/);

    const copiedKindColumns = await sql<{ column_name: string }[]>`
      SELECT column_name
        FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name = 'trigger_bindings'
         AND column_name IN ('plan_kind', 'is_triggered')`;
    expect(copiedKindColumns).toEqual([]);
  });

  it('records one provider event independently for each fan-out sink', async () => {
    const payload = sql.json({ messageId: 'm-1', subject: 'Hello' });
    const [eventBus] = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.trigger_deliveries
        (workspace_id, source_id, dedupe_key, datatype_id, event_key,
         payload, sink_kind, sink_ref, outcome, emitted_event_key)
      VALUES (
        'ws-a', ${sourceId}, 'gmail:m-1', 'email-message',
        'ext:gmail.message.received', ${payload}, 'event-bus', 'workspace',
        'delivered', 'ext:gmail.message.received'
      )
      RETURNING id`;

    await sql`
      INSERT INTO harness_shared.trigger_deliveries
        (workspace_id, source_id, dedupe_key, datatype_id, event_key,
         payload, sink_kind, sink_ref, outcome)
      VALUES (
        'ws-a', ${sourceId}, 'gmail:m-1', 'email-message',
        'ext:gmail.message.received', ${payload}, 'personal-vault', 'owner',
        'delivered'
      )`;

    await expect(sql`
      INSERT INTO harness_shared.trigger_deliveries
        (workspace_id, source_id, dedupe_key, datatype_id, event_key,
         payload, sink_kind, sink_ref)
      VALUES (
        'ws-a', ${sourceId}, 'gmail:m-1', 'email-message',
        'ext:gmail.message.received', ${payload}, 'event-bus', 'workspace'
      )
    `).rejects.toThrow(/trigger_deliveries_sink_dedupe_key/);

    await sql`
      INSERT INTO harness_shared.trigger_runs
        (workspace_id, binding_id, delivery_id, dedupe_key, status, args)
      VALUES (
        'ws-a', ${bindingId}, ${eventBus.id}, 'gmail:m-1', 'succeeded',
        ${sql.json({ messageId: 'm-1' })}
      )`;
    await expect(sql`
      INSERT INTO harness_shared.trigger_runs
        (workspace_id, binding_id, delivery_id, dedupe_key)
      VALUES ('ws-a', ${bindingId}, ${eventBus.id}, 'gmail:m-1')
    `).rejects.toThrow(/trigger_runs_binding_dedupe_key/);
  });

  it('requires every delivery to reference a canonical platform datatype', async () => {
    await expect(sql`
      INSERT INTO harness_shared.trigger_deliveries
        (workspace_id, source_id, dedupe_key, datatype_id, event_key,
         payload, sink_kind)
      VALUES (
        'ws-a', ${sourceId}, 'gmail:m-2', 'app-local-email',
        'ext:gmail.message.received', ${sql.json({ messageId: 'm-2' })},
        'event-bus'
      )
    `).rejects.toThrow(/trigger_deliveries_datatype_fk/);
  });

  it('enforces object-shaped replay state and canonical payloads', async () => {
    await expect(sql`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, cursor)
      VALUES ('ws-a', 'slack', ${sql.json(['not-an-object'])})
    `).rejects.toThrow(/trigger_sources_cursor_object_check/);

    await expect(sql`
      INSERT INTO harness_shared.trigger_deliveries
        (workspace_id, source_id, dedupe_key, datatype_id, event_key,
         payload, sink_kind)
      VALUES (
        'ws-a', ${sourceId}, 'gmail:m-3', 'email-message',
        'ext:gmail.message.received', ${sql.json(['not-an-object'])},
        'event-bus'
      )
    `).rejects.toThrow(/trigger_deliveries_payload_object_check/);
  });

  it('installs workspace-isolation RLS on every trigger table', async () => {
    const rows = await sql<{ tablename: string }[]>`
      SELECT tablename
        FROM pg_policies
       WHERE schemaname = 'harness_shared'
         AND tablename LIKE 'trigger_%'
       ORDER BY tablename`;
    expect(rows.map((row) => row.tablename)).toEqual([
      'trigger_bindings',
      'trigger_deliveries',
      'trigger_runs',
      'trigger_sources',
    ]);
  });
});
