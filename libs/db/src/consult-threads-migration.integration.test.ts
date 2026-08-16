/**
 * consult-threads-migration.integration.test.ts — migration 834 (consult threads;
 * plan get-feedback-relevance-consults-2026-08-16, P-001 / WI-39414).
 *
 * Proves, against a real Postgres (testcontainer, Docker required), what a
 * schema-drift unit test cannot:
 *  - the coord_conversations kind CHECK is WIDENED (consult accepted), not merely
 *    dropped (a bogus kind is still refused — the constraint was re-added);
 *  - the whole file is idempotent (re-apply succeeds; expand-only house style);
 *  - consult_state defaults + every CHECK (state, latency_contract, depth ≤ 2)
 *    and the (workspace_id, conversation_id) PK;
 *  - consult_post_meta kind CHECK (all six members) + (workspace_id, post_id) PK;
 *  - the five consult_state partial indexes + the post_meta conversation index exist.
 *
 * The subject is the REAL migration file (resolved .sql first, then .sql.DRAFT so
 * the test is valid both before and after arming). Falsifiability probes point
 * CONSULT_MIGRATION_SQL at a mutated COPY outside the tree (never mutate the
 * shared checkout — see CLAUDE.md "Proving a guard is falsifiable").
 *
 * Run:
 *   npx vitest run --config vitest.integration.config.ts src/consult-threads-migration.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function resolveMigrationPath(): string {
  const override = process.env.CONSULT_MIGRATION_SQL;
  if (override) return override;
  const armed = path.join(HERE, '..', 'sql', '834-consult-threads.sql');
  if (existsSync(armed)) return armed;
  const draft = `${armed}.DRAFT`;
  if (existsSync(draft)) return draft;
  throw new Error(`migration 834 not found at ${armed}[.DRAFT]`);
}

const MIGRATION_SQL = readFileSync(resolveMigrationPath(), 'utf8');

let db: MigratedTestDb;
let sql: Sql;

/** Insert a minimal coord_conversations row with the given kind. */
const insertConversation = (id: string, kind: string) =>
  sql`INSERT INTO harness_shared.coord_conversations (workspace_id, id, kind, scope, asker_id, title)
      VALUES ('ws1', ${id}, ${kind}, 'harness', 'u1', 't')`;

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'consult834' });
  sql = postgres(db.url, { max: 1, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared`);
  // Pre-834 baseline mirror: only what migration 834 touches or this test inserts.
  // The kind CHECK carries the PRE-migration member list under the REAL constraint
  // name — that is the object 834's DROP CONSTRAINT IF EXISTS must find, so the
  // widen path (not just the fresh-create path) is what gets exercised.
  await sql.unsafe(`
    CREATE TABLE harness_shared.coord_conversations (
      workspace_id text NOT NULL DEFAULT 'default',
      id text NOT NULL,
      kind text NOT NULL
        CONSTRAINT coord_conversations_kind_check
        CHECK (kind = ANY (ARRAY['question'::text, 'discussion'::text])),
      scope text NOT NULL,
      asker_id text NOT NULL,
      title text NOT NULL,
      PRIMARY KEY (workspace_id, id)
    )`);
  // Sanity: the baseline really refuses 'consult' before the migration runs —
  // otherwise the widen assertions below prove nothing.
  await expect(insertConversation('pre', 'consult')).rejects.toThrow(/coord_conversations_kind_check/);
  await sql.unsafe(MIGRATION_SQL);
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
});

describe('migration 834 — coord_conversations kind widening', () => {
  it("accepts kind='consult' after the migration", async () => {
    await insertConversation('c1', 'consult');
    const rows = await sql`SELECT kind FROM harness_shared.coord_conversations WHERE id = 'c1'`;
    expect(rows[0]?.kind).toBe('consult');
  });

  it('still refuses an unknown kind — the CHECK was re-added, not just dropped', async () => {
    await expect(insertConversation('c-bogus', 'bogus')).rejects.toThrow(/coord_conversations_kind_check/);
  });

  it('re-applying the whole migration is idempotent and preserves both behaviors', async () => {
    await sql.unsafe(MIGRATION_SQL);
    await insertConversation('c2', 'consult');
    await expect(insertConversation('c-bogus2', 'nope')).rejects.toThrow(/coord_conversations_kind_check/);
  });
});

describe('migration 834 — consult_state', () => {
  const minimal = (conversationId: string) =>
    sql`INSERT INTO harness_shared.consult_state (workspace_id, conversation_id, requester_id, question)
        VALUES ('ws1', ${conversationId}, 'req1', 'q?')`;

  it('minimal insert lands the documented defaults', async () => {
    await minimal('conv-defaults');
    const [row] = await sql`SELECT * FROM harness_shared.consult_state WHERE conversation_id = 'conv-defaults'`;
    expect(row.state).toBe('routing');
    expect(row.latency_contract).toBe('proceed');
    expect(row.max_exchanges).toBe(4);
    expect(row.exchanges_used).toBe(0);
    expect(row.wake_budget).toBe(4);
    expect(row.wakes_used).toBe(0);
    expect(row.depth).toBe(0);
    expect(row.routing).toEqual({});
    expect(row.outcome).toBeNull();
    expect(row.closed_at).toBeNull();
  });

  it('accepts every declared state and refuses an undeclared one', async () => {
    const states = [
      'routing', 'no_qualified_responder', 'awaiting_responder', 'active',
      'closed_answered', 'closed_cant_help', 'declined', 'graduated', 'expired',
    ];
    for (const [i, s] of states.entries()) {
      await sql`INSERT INTO harness_shared.consult_state (workspace_id, conversation_id, requester_id, state)
                VALUES ('ws1', ${'conv-state-' + i}, 'req1', ${s})`;
    }
    await expect(
      sql`INSERT INTO harness_shared.consult_state (workspace_id, conversation_id, requester_id, state)
          VALUES ('ws1', 'conv-state-bad', 'req1', 'pondering')`,
    ).rejects.toThrow(/consult_state_state_check/);
  });

  it('depth: 2 accepted (recursion ceiling), 3 refused', async () => {
    await sql`INSERT INTO harness_shared.consult_state (workspace_id, conversation_id, requester_id, depth, parent_consult_id)
              VALUES ('ws1', 'conv-d2', 'req1', 2, 'conv-defaults')`;
    await expect(
      sql`INSERT INTO harness_shared.consult_state (workspace_id, conversation_id, requester_id, depth)
          VALUES ('ws1', 'conv-d3', 'req1', 3)`,
    ).rejects.toThrow(/consult_state_depth_check/);
  });

  it('latency_contract: hard-blocked accepted, anything else refused', async () => {
    await sql`INSERT INTO harness_shared.consult_state (workspace_id, conversation_id, requester_id, latency_contract)
              VALUES ('ws1', 'conv-hb', 'req1', 'hard-blocked')`;
    await expect(
      sql`INSERT INTO harness_shared.consult_state (workspace_id, conversation_id, requester_id, latency_contract)
          VALUES ('ws1', 'conv-lc-bad', 'req1', 'whenever')`,
    ).rejects.toThrow(/consult_state_latency_check/);
  });

  it('one consult_state per conversation — PK refuses a duplicate', async () => {
    await minimal('conv-dup');
    await expect(minimal('conv-dup')).rejects.toThrow(/consult_state_pkey/);
  });
});

describe('migration 834 — consult_post_meta', () => {
  it('accepts every declared post kind and refuses an undeclared one', async () => {
    const kinds = ['question', 'answer', 'clarifying_question', 'new_fact', 'decline', 'close'];
    for (const [i, k] of kinds.entries()) {
      await sql`INSERT INTO harness_shared.consult_post_meta (workspace_id, post_id, conversation_id, author_id, kind)
                VALUES ('ws1', ${i + 1}, 'conv-defaults', 'u1', ${k})`;
    }
    await expect(
      sql`INSERT INTO harness_shared.consult_post_meta (workspace_id, post_id, conversation_id, kind)
          VALUES ('ws1', 99, 'conv-defaults', 'musing')`,
    ).rejects.toThrow(/consult_post_meta_kind_check/);
  });

  it('PK on (workspace_id, post_id) refuses a duplicate overlay for one post', async () => {
    await sql`INSERT INTO harness_shared.consult_post_meta (workspace_id, post_id, conversation_id, kind)
              VALUES ('ws1', 500, 'conv-defaults', 'question')`;
    await expect(
      sql`INSERT INTO harness_shared.consult_post_meta (workspace_id, post_id, conversation_id, kind)
          VALUES ('ws1', 500, 'conv-defaults', 'answer')`,
    ).rejects.toThrow(/consult_post_meta_pkey/);
  });
});

describe('migration 834 — indexes', () => {
  it('creates the five consult_state indexes, the post_meta conversation index, and both PKs', async () => {
    const rows = await sql`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'harness_shared' AND tablename IN ('consult_state', 'consult_post_meta')
        AND indexname LIKE 'consult_%'`;
    const names = rows.map((r) => r.indexname).sort();
    expect(names).toEqual([
      'consult_post_meta_conversation_idx',
      'consult_post_meta_pkey',
      'consult_state_expiry_idx',
      'consult_state_origin_idx',
      'consult_state_parent_idx',
      'consult_state_pkey',
      'consult_state_responder_idx',
      'consult_state_state_idx',
    ]);
  });
});
