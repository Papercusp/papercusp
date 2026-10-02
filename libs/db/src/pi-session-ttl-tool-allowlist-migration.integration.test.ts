/** Migration 1342 — durable expiry and exact tool-name scope for PI sessions. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  path.join(HERE, '..', 'sql', '1342-pi-session-expiry-tool-allowlist.sql'),
  'utf8',
);

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'pi1342' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.pi_sessions (
      workspace_id text NOT NULL,
      session_id text NOT NULL,
      bearer_hash text NOT NULL,
      capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      PRIMARY KEY (workspace_id, session_id)
    );
    INSERT INTO harness_shared.pi_sessions
      (workspace_id, session_id, bearer_hash, started_at)
    VALUES ('ws-old', 'old-session', 'hash-old', now() - interval '2 days');
  `);
  await sql.unsafe(migration);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('PI session scope and expiry migration', () => {
  it('gives existing rows a bounded migration grace period', async () => {
    const [row] = await sql<{ expires_at: Date; allowed_tools: unknown }[]>`
      SELECT expires_at, allowed_tools
        FROM harness_shared.pi_sessions
       WHERE workspace_id = 'ws-old' AND session_id = 'old-session'`;
    expect(row.expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(row.expires_at.getTime()).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000);
    expect(row.allowed_tools).toBeNull();
  });

  it('keeps the deployed writer working when it omits the new columns', async () => {
    await sql`
      INSERT INTO harness_shared.pi_sessions
        (workspace_id, session_id, bearer_hash, capabilities)
      VALUES ('ws-legacy-writer', 'legacy-session', 'hash-legacy', '[]'::jsonb)`;
    const [row] = await sql<{ expires_at: Date; allowed_tools: unknown }[]>`
      SELECT expires_at, allowed_tools
        FROM harness_shared.pi_sessions
       WHERE workspace_id = 'ws-legacy-writer' AND session_id = 'legacy-session'`;
    expect(row.expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(row.expires_at.getTime()).toBeLessThan(Date.now() + 25 * 60 * 60 * 1000);
    expect(row.allowed_tools).toBeNull();
  });

  it('defaults new rows to an expiry and stores exact canonical names', async () => {
    await sql`
      INSERT INTO harness_shared.pi_sessions
        (workspace_id, session_id, bearer_hash, capabilities, allowed_tools)
      VALUES ('ws-new', 'new-session', 'hash-new', '[]'::jsonb,
        ${JSON.stringify(['chat:ask_choice', 'tasks:ops'])}::jsonb)`;
    const [row] = await sql<{ expires_at: Date; allowed_tools: unknown }[]>`
      SELECT expires_at, allowed_tools
        FROM harness_shared.pi_sessions
       WHERE workspace_id = 'ws-new' AND session_id = 'new-session'`;
    expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    const storedTools = typeof row.allowed_tools === 'string'
      ? JSON.parse(row.allowed_tools)
      : row.allowed_tools;
    expect(storedTools).toEqual(['chat:ask_choice', 'tasks:ops']);
  });
});
