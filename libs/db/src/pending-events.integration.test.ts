/**
 * pending-events — the orchestrator event queue, proven against a REAL Postgres
 * (testcontainer; Docker required). Covers insert → list (ordering, due-filter,
 * workspace-scope) → consume (single/batch, idempotent, workspace defense).
 *
 * Run: cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/pending-events.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import {
  insertPendingEvent,
  listUnconsumedEvents,
  consumeEvent,
  consumeEvents,
} from './pending-events';

let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'pevents',
    provision: async (url) => {
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
        // Stand-in matching the columns the helpers read/write (migration 010 shape).
        await s.unsafe(`
          CREATE TABLE harness_shared.pending_events (
            id           text PRIMARY KEY,
            workspace_id text NOT NULL,
            install_slug text NOT NULL,
            kind         text NOT NULL,
            target_role  text NOT NULL,
            payload      jsonb,
            due_at       timestamptz,
            source_id    text,
            created_at   timestamptz NOT NULL DEFAULT now(),
            consumed_at  timestamptz,
            consumed_by  text
          )`);
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 8, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.pending_events`;
});

const WS = 'ws-a';

describe('insertPendingEvent', () => {
  it('inserts and returns the mapped event with a parsed payload', async () => {
    const ev = await insertPendingEvent(sql, {
      workspaceId: WS,
      installSlug: 'papercup',
      kind: 'routine',
      targetRole: 'reviewer',
      payload: { foo: 'bar', n: 1 },
    });
    expect(ev.installSlug).toBe('papercup');
    expect(ev.kind).toBe('routine');
    expect(ev.targetRole).toBe('reviewer');
    expect(ev.payload).toEqual({ foo: 'bar', n: 1 });
    expect(ev.consumedAt).toBeNull();
    expect(ev.consumedBy).toBeNull();
    expect(ev.createdAt).toBeInstanceOf(Date);
  });

  it('stores a null payload when none is given', async () => {
    const ev = await insertPendingEvent(sql, { workspaceId: WS, installSlug: 'x', kind: 'api', targetRole: 'worker' });
    expect(ev.payload).toBeNull();
  });
});

describe('listUnconsumedEvents', () => {
  it('returns only unconsumed events for the install, NULL-due first then by created_at', async () => {
    const future = new Date(Date.now() + 60_000);
    const withDue = await insertPendingEvent(sql, { workspaceId: WS, installSlug: 'h', kind: 'routine', targetRole: 'r', dueAt: future });
    const noDue = await insertPendingEvent(sql, { workspaceId: WS, installSlug: 'h', kind: 'api', targetRole: 'r' });

    const list = await listUnconsumedEvents(sql, 'h');
    expect(list.map((e) => e.id)).toEqual([noDue.id, withDue.id]); // NULLS FIRST
  });

  it('onlyDue excludes events whose due_at is in the future', async () => {
    await insertPendingEvent(sql, { workspaceId: WS, installSlug: 'h', kind: 'routine', targetRole: 'r', dueAt: new Date(Date.now() + 60_000) });
    const past = await insertPendingEvent(sql, { workspaceId: WS, installSlug: 'h', kind: 'routine', targetRole: 'r', dueAt: new Date(Date.now() - 60_000) });

    const due = await listUnconsumedEvents(sql, 'h', { onlyDue: true });
    expect(due.map((e) => e.id)).toEqual([past.id]);
  });

  it('scopes to the requested workspace when supplied', async () => {
    await insertPendingEvent(sql, { workspaceId: 'ws-a', installSlug: 'shared', kind: 'api', targetRole: 'r' });
    const bEvt = await insertPendingEvent(sql, { workspaceId: 'ws-b', installSlug: 'shared', kind: 'api', targetRole: 'r' });

    const all = await listUnconsumedEvents(sql, 'shared');
    expect(all).toHaveLength(2); // no workspace filter → both
    const onlyB = await listUnconsumedEvents(sql, 'shared', { workspaceId: 'ws-b' });
    expect(onlyB.map((e) => e.id)).toEqual([bEvt.id]);
  });

  it('respects the limit', async () => {
    for (let i = 0; i < 3; i++) {
      await insertPendingEvent(sql, { workspaceId: WS, installSlug: 'h', kind: 'api', targetRole: 'r' });
    }
    expect(await listUnconsumedEvents(sql, 'h', { limit: 2 })).toHaveLength(2);
  });
});

describe('consumeEvent / consumeEvents', () => {
  it('marks an event consumed once (idempotent — second consume is a no-op)', async () => {
    const ev = await insertPendingEvent(sql, { workspaceId: WS, installSlug: 'h', kind: 'api', targetRole: 'r' });
    expect(await consumeEvent(sql, ev.id, 'orchestrator')).toBe(true);
    expect(await consumeEvent(sql, ev.id, 'orchestrator')).toBe(false);
    expect(await listUnconsumedEvents(sql, 'h')).toHaveLength(0);
  });

  it('will not consume across a workspace boundary', async () => {
    const ev = await insertPendingEvent(sql, { workspaceId: 'ws-a', installSlug: 'h', kind: 'api', targetRole: 'r' });
    expect(await consumeEvent(sql, ev.id, 'orchestrator', 'ws-b')).toBe(false);
    expect(await consumeEvent(sql, ev.id, 'orchestrator', 'ws-a')).toBe(true);
  });

  it('batch-consumes and returns the count of newly-consumed rows', async () => {
    const a = await insertPendingEvent(sql, { workspaceId: WS, installSlug: 'h', kind: 'api', targetRole: 'r' });
    const b = await insertPendingEvent(sql, { workspaceId: WS, installSlug: 'h', kind: 'api', targetRole: 'r' });
    await consumeEvent(sql, a.id, 'x'); // already consumed
    const n = await consumeEvents(sql, [a.id, b.id], 'orchestrator');
    expect(n).toBe(1); // only b was still unconsumed
  });

  it('consumeEvents([]) is a 0-cost no-op', async () => {
    expect(await consumeEvents(sql, [], 'orchestrator')).toBe(0);
  });
});
