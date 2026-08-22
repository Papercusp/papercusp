/**
 * Regression coverage for migration 885.
 *
 * Older consult:close calls left the typed consult_state row terminal while
 * coord_conversations stayed open.  This applies the real migration to a
 * throwaway Postgres database, checks answer/post recovery, and proves the
 * terminal-close integrity query is empty and the migration is idempotent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTestPg } from '@papercusp/test-config/pg';

const WS = 'ws-consult-lifecycle-backfill';
const MIGRATION_834 = fileURLToPath(
  new URL('../sql/834-consult-threads.sql', import.meta.url),
);
const MIGRATION_885 = fileURLToPath(
  new URL('../sql/886-backfill-consult-conversation-lifecycle.sql', import.meta.url),
);

let rootSql: Sql;
let adminUri: string;
let dbName: string;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `consultlc_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_conversations (
      workspace_id text NOT NULL,
      id text NOT NULL,
      kind text NOT NULL
        CONSTRAINT coord_conversations_kind_check
        CHECK (kind = ANY (ARRAY['question'::text, 'discussion'::text])),
      state text NOT NULL DEFAULT 'open',
      accepted_answer text,
      accepted_post_id bigint,
      updated_at timestamptz NOT NULL,
      resolved_at timestamptz,
      PRIMARY KEY (workspace_id, id)
    )`);
  await rootSql.unsafe(readFileSync(MIGRATION_834, 'utf8'));
}, 120_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 }).catch(() => {});
  if (!adminUri || !dbName) return;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
});

async function seedConsult(input: {
  id: string;
  state: 'active' | 'closed_answered' | 'closed_cant_help' | 'graduated';
  outcome?: Record<string, unknown>;
  closedAt?: string;
  coarseState?: 'open' | 'closed';
  closePostId?: number;
}): Promise<void> {
  const closedAt = input.closedAt ?? '2026-08-20T21:12:26.766Z';
  await rootSql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, state, question, outcome, closed_at, updated_at)
    VALUES
      (${WS}, ${input.id}, 'requester', ${input.state}, 'question',
       ${input.outcome ? rootSql.json(input.outcome as never) : null},
       ${input.state === 'active' ? null : closedAt}::timestamptz,
       ${closedAt}::timestamptz)
  `;
  await rootSql`
    INSERT INTO harness_shared.coord_conversations
      (workspace_id, id, kind, state, updated_at)
    VALUES
      (${WS}, ${input.id}, 'consult', ${input.coarseState ?? 'open'}, ${closedAt}::timestamptz)
  `;
  if (input.closePostId != null) {
    await rootSql`
      INSERT INTO harness_shared.consult_post_meta
        (workspace_id, post_id, conversation_id, kind)
      VALUES (${WS}, ${input.closePostId}, ${input.id}, 'close')
    `;
  }
}

async function lifecycleRows() {
  return rootSql`
    SELECT c.id,
           c.state,
           c.accepted_answer,
           c.accepted_post_id::text AS accepted_post_id,
           c.resolved_at IS NOT NULL AS has_resolved_at
      FROM harness_shared.coord_conversations c
     WHERE c.workspace_id = ${WS}
     ORDER BY c.id COLLATE "C"
  `;
}

describe('migration 886 — consult/coarse conversation lifecycle backfill', () => {
  it('repairs typed close terminals, leaves non-close states alone, and is idempotent', async () => {
    await seedConsult({
      id: 'answered-with-post',
      state: 'closed_answered',
      outcome: { answer: 'the answer', confidence: 0.9 },
      closePostId: 17,
    });
    await seedConsult({
      id: 'answered-without-post',
      state: 'closed_answered',
      outcome: { answer: 'recoverable answer' },
    });
    await seedConsult({
      id: 'cant-help',
      state: 'closed_cant_help',
      outcome: { reason: 'outside the responder context' },
    });
    await seedConsult({
      id: 'graduated',
      state: 'graduated',
      outcome: { reason: 'outgrew the consult', work_item_id: 'WI-1' },
    });
    await seedConsult({ id: 'still-active', state: 'active' });
    await seedConsult({ id: 'already-closed', state: 'closed_cant_help', coarseState: 'closed' });

    const migrationSql = readFileSync(MIGRATION_885, 'utf8');
    await rootSql.unsafe(migrationSql);

    expect(await lifecycleRows()).toEqual([
      { id: 'already-closed', state: 'closed', accepted_answer: null, accepted_post_id: null, has_resolved_at: false },
      { id: 'answered-with-post', state: 'resolved', accepted_answer: 'the answer', accepted_post_id: '17', has_resolved_at: true },
      { id: 'answered-without-post', state: 'resolved', accepted_answer: 'recoverable answer', accepted_post_id: null, has_resolved_at: true },
      { id: 'cant-help', state: 'closed', accepted_answer: null, accepted_post_id: null, has_resolved_at: false },
      { id: 'graduated', state: 'closed', accepted_answer: null, accepted_post_id: null, has_resolved_at: false },
      { id: 'still-active', state: 'open', accepted_answer: null, accepted_post_id: null, has_resolved_at: false },
    ]);

    const integrityViolations = await rootSql`
      SELECT cs.workspace_id, cs.conversation_id, cs.state, c.state AS coarse_state
        FROM harness_shared.consult_state cs
        JOIN harness_shared.coord_conversations c
          ON c.workspace_id = cs.workspace_id AND c.id = cs.conversation_id
       WHERE cs.state IN ('closed_answered', 'closed_cant_help', 'graduated')
         AND c.kind = 'consult'
         AND c.state = 'open'
    `;
    expect(integrityViolations).toEqual([]);

    const afterFirstRun = await lifecycleRows();
    await rootSql.unsafe(migrationSql);
    expect(await lifecycleRows()).toEqual(afterFirstRun);
  });
});
