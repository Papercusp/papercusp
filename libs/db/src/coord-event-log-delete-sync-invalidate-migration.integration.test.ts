/**
 * Migration 1433 keeps coord:inbox cache invalidation in sync with message GC.
 * Real Postgres (testcontainer; Docker required). Run:
 *   npm run test:integration -- src/coord-event-log-delete-sync-invalidate-migration.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(HERE, '..', 'sql');
const MIGRATION_FILE = '1433-coord-event-log-delete-sync-invalidate.sql';
const NOTIFY_FUNCTION_SQL = readFileSync(
  join(SQL_DIR, '1213-sync-notify-coalesce-bulk-fold.sql'),
  'utf8',
);
const ORIGINAL_TRIGGER_SQL = readFileSync(
  join(SQL_DIR, '275-coord-event-log-sync-invalidate.sql'),
  'utf8',
);

function readMigration(): string {
  const armed = join(SQL_DIR, MIGRATION_FILE);
  if (existsSync(armed)) return readFileSync(armed, 'utf8');
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return readFileSync(draft, 'utf8');
  throw new Error(`migration 1433 not found at ${armed}[.DRAFT]`);
}

let db: MigratedTestDb;
let sql: Sql;
let listener: Sql;

interface SyncInvalidation {
  name: string;
  args: { op: string; workspace_id?: string | null; id?: number | string | null };
}

const received: SyncInvalidation[] = [];
const COORD_EVENT_LOG = 'harness_shared.coord_event_log.changed';
const coordEventLogInvalidations = (): SyncInvalidation[] =>
  received.filter((notification) => notification.name === COORD_EVENT_LOG);
const settle = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function appendMessage(msgId: string, notifyKind?: string): Promise<number | string> {
  const body = {
    kind: 'message',
    msg_id: msgId,
    to: ['owner-a'],
    ...(notifyKind ? { notify_kind: notifyKind } : {}),
  };
  const [row] = await sql<{ id: number | string }[]>`
    INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body)
    VALUES ('test-ws', 'messages', ${msgId}, ${sql.json(body)})
    RETURNING id`;
  return row!.id;
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'coordlogdelete1433' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE harness_shared.coord_event_log (
      id BIGSERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      writer_key TEXT,
      msg_id TEXT NOT NULL,
      body JSONB NOT NULL,
      harness_slug TEXT,
      ts TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await sql.unsafe(NOTIFY_FUNCTION_SQL);
  await sql.unsafe(ORIGINAL_TRIGGER_SQL);
  await sql.unsafe(`SELECT set_config('app.workspace_id', 'test-ws', false)`);

  listener = postgres(db.url, { max: 1, onnotice: () => {} });
  await listener.listen('sync_invalidate', (payload: string) => {
    try {
      received.push(JSON.parse(payload) as SyncInvalidation);
    } catch {
      /* Ignore non-JSON notifications. */
    }
  });
}, 120_000);

afterAll(async () => {
  await listener?.end({ timeout: 5 }).catch(() => {});
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 1433 — coord_event_log delete invalidation', () => {
  it('repairs the migration 275 delete gap and excludes fan-out copies', async () => {
    const beforeFixId = await appendMessage('before-delete-fix');
    await settle();
    received.length = 0;

    // Migration 275 only installs INSERT/UPDATE notifications, so this deletion
    // reproduces the stale coord:inbox cache condition before the fix.
    await sql`DELETE FROM harness_shared.coord_event_log WHERE id = ${beforeFixId}`;
    await settle();
    expect(coordEventLogInvalidations()).toHaveLength(0);

    const migrationSql = readMigration();
    await sql.unsafe(migrationSql);
    await sql.unsafe(migrationSql); // The migration is safe to re-apply.
    const [shape] = await sql<{ delete_triggers: number }[]>`
      SELECT count(*)::int AS delete_triggers
        FROM pg_trigger
       WHERE tgrelid = 'harness_shared.coord_event_log'::regclass
         AND tgname = 'emit_change_notify_delete_trg'
         AND NOT tgisinternal`;
    expect(shape?.delete_triggers).toBe(1);

    const originalId = await appendMessage('after-delete-fix');
    await settle();
    received.length = 0;
    await sql`DELETE FROM harness_shared.coord_event_log WHERE id = ${originalId}`;
    await settle();

    const invalidations = coordEventLogInvalidations();
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]).toMatchObject({
      name: COORD_EVENT_LOG,
      args: { op: 'DELETE', workspace_id: 'test-ws' },
    });
    expect(String(invalidations[0]!.args.id)).toBe(String(originalId));

    const fanoutCopyId = await appendMessage('fanout-copy', 'subscriber-inbox');
    await settle();
    received.length = 0;
    await sql`DELETE FROM harness_shared.coord_event_log WHERE id = ${fanoutCopyId}`;
    await settle();
    expect(coordEventLogInvalidations()).toHaveLength(0);
  });
});
