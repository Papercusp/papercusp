/**
 * Migration 898 — detach external-trigger bindings without deleting history.
 *
 * Applies the real 876 core migration followed by 898 on fresh PostgreSQL,
 * then proves the detached binding remains addressable from trigger_runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(number: number, name: string): string {
  const armed = path.join(HERE, '..', 'sql', `${number}-${name}.sql`);
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration ${number} not found at ${armed}[.DRAFT]`);
}

const coreSql = readFileSync(migrationPath(876, 'external-trigger-core'), 'utf8');
const detachSql = readFileSync(migrationPath(898, 'external-trigger-binding-detach'), 'utf8');

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'triggerdetach898' });
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
    VALUES ('ws-a', 'papercusp', 'respond-to-email');
    INSERT INTO harness_shared.datatype_registry (workspace_id, id)
    VALUES ('ws-a', 'email-message');
  `);
  await sql.unsafe(coreSql);
  await sql.unsafe(detachSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 898 — external-trigger binding detach lifecycle', () => {
  it('is idempotent and installs the nullable lifecycle column plus partial index', async () => {
    await sql.unsafe(detachSql);

    const columns = await sql<{ column_name: string; is_nullable: string }[]>`
      SELECT column_name, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name = 'trigger_bindings'
         AND column_name = 'detached_at'`;
    expect(columns).toEqual([{ column_name: 'detached_at', is_nullable: 'YES' }]);

    const indexes = await sql<{ indexdef: string }[]>`
      SELECT indexdef
        FROM pg_indexes
       WHERE schemaname = 'harness_shared'
         AND tablename = 'trigger_bindings'
         AND indexname = 'trigger_bindings_installed_plan_idx'`;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.indexdef).toContain('WHERE (detached_at IS NULL)');
  });

  it('detaches an installed binding while preserving its run-history foreign key', async () => {
    const [source] = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.trigger_sources
        (workspace_id, kind, credential_ref, status, cursor)
      VALUES (
        'ws-a', 'gmail', 'google-workspace:owner', 'connected',
        ${sql.json({ historyId: '1234' })}
      )
      RETURNING id`;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug,
         event_pattern, action, armed, storm_policy)
      VALUES (
        'ws-a', ${source.id}, 'papercusp', 'respond-to-email',
        'ext:gmail.message.received', ${sql.json({ type: 'run-plan' })}, true,
        ${sql.json({ mode: 'coalesce', windowSeconds: 60 })}
      )
      RETURNING id`;
    const [delivery] = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.trigger_deliveries
        (workspace_id, source_id, dedupe_key, datatype_id, event_key,
         payload, sink_kind, sink_ref, outcome)
      VALUES (
        'ws-a', ${source.id}, 'gmail:m-898', 'email-message',
        'ext:gmail.message.received', ${sql.json({ messageId: 'm-898' })},
        'event-bus', 'workspace', 'delivered'
      )
      RETURNING id`;
    const [run] = await sql<{ id: string }[]>`
      INSERT INTO harness_shared.trigger_runs
        (workspace_id, binding_id, delivery_id, dedupe_key, status, args)
      VALUES (
        'ws-a', ${binding.id}, ${delivery.id}, 'gmail:m-898', 'succeeded',
        ${sql.json({ messageId: 'm-898' })}
      )
      RETURNING id`;

    const [detached] = await sql<{ armed: boolean; detached_at: Date | string }[]>`
      UPDATE harness_shared.trigger_bindings
         SET armed = false,
             detached_at = now()
       WHERE workspace_id = 'ws-a'
         AND id = ${binding.id}::uuid
      RETURNING armed, detached_at`;
    expect(detached.armed).toBe(false);
    expect(detached.detached_at).toBeTruthy();

    const rows = await sql<{ run_id: string; binding_id: string; detached_at: Date | string }[]>`
      SELECT r.id::text AS run_id,
             b.id::text AS binding_id,
             b.detached_at
        FROM harness_shared.trigger_runs r
        JOIN harness_shared.trigger_bindings b
          ON b.workspace_id = r.workspace_id AND b.id = r.binding_id
       WHERE r.workspace_id = 'ws-a'
         AND r.id = ${run.id}::uuid`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_id: run.id, binding_id: binding.id });
    expect(rows[0]!.detached_at).toBeTruthy();
  });
});
