/** Migration 891 — durable Gmail watch/history/PubSub poll routine. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function migrationPath(): string {
  const armed = path.join(HERE, '..', 'sql', '891-google-gmail-poll-routine.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 891 not found at ${armed}[.DRAFT]`);
}

const migrationSql = readFileSync(migrationPath(), 'utf8');
let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'gmail891' });
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
  await sql.unsafe(migrationSql);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 891 — Google Gmail poll routine', () => {
  it('seeds the active one-minute durable action with bounded pull and renewal settings', async () => {
    const rows = await sql<
      Array<{
        target_role: string;
        trigger_config: Record<string, unknown>;
        concurrency: string;
        catchup: string;
        active: boolean;
        tier: string;
      }>
    >`
      SELECT target_role, trigger_config, concurrency, catchup, active, tier
        FROM harness_shared.routines
       WHERE install_slug = 'papercusp' AND name = 'google-gmail-poll'`;
    expect(rows).toEqual([
      {
        target_role: 'system:google-gmail-poll',
        trigger_config: { cron: '15 * * * * *', max_messages: 100, renew_before_ms: 86_400_000 },
        concurrency: 'skip',
        catchup: 'skip-old',
        active: true,
        tier: 'durable',
      },
    ]);
  });

  it('is idempotent and preserves an explicit operator pause', async () => {
    await sql`
      UPDATE harness_shared.routines
         SET active = FALSE
       WHERE install_slug = 'papercusp' AND name = 'google-gmail-poll'`;
    await sql.unsafe(migrationSql);
    const rows = await sql<Array<{ count: number; active: boolean }>>`
      SELECT count(*)::int AS count, bool_and(active) AS active
        FROM harness_shared.routines
       WHERE install_slug = 'papercusp' AND name = 'google-gmail-poll'`;
    expect(rows).toEqual([{ count: 1, active: false }]);
  });
});
