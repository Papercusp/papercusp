/**
 * Migration 1066 — append-only escalation reopen compensation.
 *
 * Run:
 *   npm run test:integration -- src/coord-escalation-reopen-compensation-migration.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = join(HERE, '..', 'sql', '1066-coord-escalation-reopen-compensation.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 1066 not found at ${armed}[.DRAFT]`);
}

const MIGRATION_SQL = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

async function append(msgId: string, kind: string, related: string | null, generation = 0): Promise<void> {
  const body = {
    msg_id: msgId,
    ts: new Date().toISOString(),
    from: 'actor',
    to: ['human'],
    kind,
    ...(related ? { related_msg_id: related } : {}),
    ...(kind === 'escalation' ? { severity: 'question', summary: 'choose', resolved: null } : {}),
    ...(kind === 'escalation_resolved' ? { choice: 'done', generation } : {}),
    ...(kind === 'escalation_reopened' ? { generation } : {}),
  };
  await sql`
    INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, ts, body)
    VALUES (
      'ws-1',
      'escalations',
      ${msgId},
      now(),
      ${body}::jsonb
    )`;
}

async function projected(): Promise<string[]> {
  const rows = await sql<Array<{ workspace_id: string; msg_id: string }>>`
    SELECT workspace_id, msg_id
      FROM harness_shared.coord_open_escalations
     ORDER BY workspace_id, msg_id`;
  return rows.map((row) => `${row.workspace_id}:${row.msg_id}`);
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'coord-reopen-1066' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE harness_shared.coord_event_log (
      id BIGSERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      body JSONB NOT NULL,
      UNIQUE (workspace_id, surface, msg_id)
    );
  `);
  await append('esc-1', 'escalation', null);
  await append('res-esc-1', 'escalation_resolved', 'esc-1');
  await sql.unsafe(MIGRATION_SQL);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1066 — coord escalation reopen compensation', () => {
  it('keeps a historically resolved escalation closed after backfill', async () => {
    expect(await projected()).toEqual([]);
  });

  it('reopens and re-resolves through append-only lifecycle events', async () => {
    await append('reopen-esc-1-g1', 'escalation_reopened', 'esc-1', 1);
    const lifecycle = await sql<Array<{ msg_id: string; surface: string; kind: string; related: string | null }>>`
      SELECT msg_id, surface, body->>'kind' AS kind, body->>'related_msg_id' AS related
        FROM harness_shared.coord_event_log
       WHERE workspace_id = 'ws-1'
       ORDER BY id`;
    expect(lifecycle).toEqual([
      { msg_id: 'esc-1', surface: 'escalations', kind: 'escalation', related: null },
      { msg_id: 'res-esc-1', surface: 'escalations', kind: 'escalation_resolved', related: 'esc-1' },
      { msg_id: 'reopen-esc-1-g1', surface: 'escalations', kind: 'escalation_reopened', related: 'esc-1' },
    ]);
    expect(await projected()).toEqual(['ws-1:esc-1']);

    await append('res-esc-1-g1', 'escalation_resolved', 'esc-1', 1);
    expect(await projected()).toEqual([]);

    await append('reopen-esc-1-g2', 'escalation_reopened', 'esc-1', 2);
    expect(await projected()).toEqual(['ws-1:esc-1']);
  });

  it('is idempotent and reconciles the latest lifecycle event', async () => {
    await sql.unsafe(MIGRATION_SQL);
    expect(await projected()).toEqual(['ws-1:esc-1']);

    const [shape] = await sql<{ triggers: number }[]>`
      SELECT count(*)::int AS triggers
        FROM pg_trigger
       WHERE tgname = 'coord_open_escalations_trg'
         AND NOT tgisinternal`;
    expect(shape).toEqual({ triggers: 1 });
  });
});
