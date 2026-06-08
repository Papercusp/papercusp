/**
 * routines-runtime — the substrate's cron routine ticker, proven against a REAL
 * Postgres (testcontainer; Docker required). Covers upsert (insert + ON CONFLICT
 * update), the due-query, the fire concurrency policies (queue/skip/cancel-prev),
 * and activate/delete.
 *
 * Run: npx vitest run --config vitest.integration.config.ts src/routines-runtime.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import {
  listDueCronRoutines,
  fireRoutine,
  upsertRoutine,
  setRoutineActive,
  deleteRoutine,
  type RoutineRow,
} from './routines-runtime';
import { listUnconsumedEvents } from './pending-events';

let db: MigratedTestDb;
let sql: Sql;

// Deterministic cron-advance stand-in: always +1h from `from`.
const nextFn = (_cron: string, from: Date): Date => new Date(from.getTime() + 3_600_000);
const WS = 'ws-a';

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'routines',
    provision: async (url) => {
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
        await s.unsafe(`
          CREATE TABLE harness_shared.routines (
            id text PRIMARY KEY,
            workspace_id text NOT NULL,
            install_slug text NOT NULL,
            name text NOT NULL,
            trigger_kind text NOT NULL,
            trigger_config jsonb,
            target_role text NOT NULL,
            payload_template jsonb,
            concurrency text NOT NULL DEFAULT 'queue',
            catchup text NOT NULL DEFAULT 'skip-old',
            active boolean NOT NULL DEFAULT true,
            next_fire_at timestamptz,
            last_fired_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE (install_slug, name)
          )`);
        await s.unsafe(`
          CREATE TABLE harness_shared.pending_events (
            id text PRIMARY KEY, workspace_id text NOT NULL, install_slug text NOT NULL,
            kind text NOT NULL, target_role text NOT NULL, payload jsonb, due_at timestamptz,
            source_id text, created_at timestamptz NOT NULL DEFAULT now(),
            consumed_at timestamptz, consumed_by text
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
  await sql`TRUNCATE harness_shared.routines`;
  await sql`TRUNCATE harness_shared.pending_events`;
});

const baseInput = (over: Partial<Parameters<typeof upsertRoutine>[1]> = {}) => ({
  workspaceId: WS,
  installSlug: 'papercup',
  name: 'nightly',
  triggerKind: 'cron' as const,
  triggerConfig: { cron: '0 0 * * *' },
  targetRole: 'curator',
  ...over,
});

describe('upsertRoutine', () => {
  it('inserts a new routine and computes next_fire_at from the cron stand-in', async () => {
    const r = await upsertRoutine(sql, baseInput(), nextFn);
    expect(r.installSlug).toBe('papercup');
    expect(r.name).toBe('nightly');
    expect(r.triggerConfig).toEqual({ cron: '0 0 * * *' });
    expect(r.active).toBe(true);
    expect(r.nextFireAt).toBeInstanceOf(Date);
  });

  it('updates in place on (install_slug, name) conflict', async () => {
    await upsertRoutine(sql, baseInput(), nextFn);
    const updated = await upsertRoutine(sql, baseInput({ targetRole: 'reviewer', concurrency: 'skip' }), nextFn);
    expect(updated.targetRole).toBe('reviewer');
    expect(updated.concurrency).toBe('skip');
    const all = await sql`SELECT count(*)::int AS n FROM harness_shared.routines`;
    expect(all[0].n).toBe(1); // updated, not duplicated
  });

  it('honors an explicit one-shot nextFireAt over the cron computation', async () => {
    const at = new Date(Date.now() + 5_000);
    const r = await upsertRoutine(sql, baseInput({ name: 'oneshot', nextFireAt: at }), nextFn);
    expect(r.nextFireAt?.getTime()).toBe(at.getTime());
  });
});

describe('listDueCronRoutines', () => {
  it('returns active cron routines that are due, excluding inactive/non-cron/future', async () => {
    await upsertRoutine(sql, baseInput({ name: 'due', nextFireAt: new Date(Date.now() - 1000) }), nextFn);
    await upsertRoutine(sql, baseInput({ name: 'future', nextFireAt: new Date(Date.now() + 60_000) }), nextFn);
    await upsertRoutine(sql, baseInput({ name: 'inactive', active: false, nextFireAt: new Date(Date.now() - 1000) }), nextFn);
    await upsertRoutine(sql, baseInput({ name: 'webhook', triggerKind: 'webhook', triggerConfig: { webhook_token: 't' } }), nextFn);

    const due = await listDueCronRoutines(sql);
    expect(due.map((r) => r.name)).toEqual(['due']);
  });
});

describe('fireRoutine — concurrency policies', () => {
  const fetchRoutine = async (name: string): Promise<RoutineRow> =>
    (await listDueCronRoutines(sql)).find((r) => r.name === name) ??
    // not "due"? read it directly
    (await upsertRoutine(sql, baseInput({ name, nextFireAt: new Date(Date.now() - 1) }), nextFn));

  it('queue: always inserts a pending_event tagged with the routine id + name', async () => {
    const r = await upsertRoutine(sql, baseInput({ name: 'q', concurrency: 'queue', nextFireAt: new Date(Date.now() - 1) }), nextFn);
    const res = await fireRoutine(sql, r, nextFn);
    expect(res).not.toBeNull();
    const evts = await listUnconsumedEvents(sql, 'papercup');
    expect(evts).toHaveLength(1);
    expect(evts[0].sourceId).toBe(r.id);
    expect(evts[0].payload).toMatchObject({ routine_name: 'q' });
    expect(evts[0].kind).toBe('routine');
  });

  it('skip: returns null and fires no new event when a prior unconsumed event exists', async () => {
    const r = await upsertRoutine(sql, baseInput({ name: 's', concurrency: 'skip', nextFireAt: new Date(Date.now() - 1) }), nextFn);
    await fireRoutine(sql, r, nextFn); // first fire → 1 event
    const second = await fireRoutine(sql, r, nextFn); // prior unconsumed → skip
    expect(second).toBeNull();
    expect(await listUnconsumedEvents(sql, 'papercup')).toHaveLength(1);
  });

  it('cancel-prev: consumes the prior event and inserts a fresh one', async () => {
    const r = await upsertRoutine(sql, baseInput({ name: 'c', concurrency: 'cancel-prev', nextFireAt: new Date(Date.now() - 1) }), nextFn);
    await fireRoutine(sql, r, nextFn);
    await fireRoutine(sql, r, nextFn);
    const live = await listUnconsumedEvents(sql, 'papercup');
    expect(live).toHaveLength(1); // prior cancelled, one fresh remains
  });
});

describe('setRoutineActive / deleteRoutine', () => {
  it('toggles active and reports whether a row matched', async () => {
    await upsertRoutine(sql, baseInput({ name: 'toggle' }), nextFn);
    expect(await setRoutineActive(sql, 'papercup', 'toggle', false)).toBe(true);
    expect(await setRoutineActive(sql, 'papercup', 'missing', false)).toBe(false);
  });

  it('deletes and reports whether a row matched', async () => {
    await upsertRoutine(sql, baseInput({ name: 'gone' }), nextFn);
    expect(await deleteRoutine(sql, 'papercup', 'gone')).toBe(true);
    expect(await deleteRoutine(sql, 'papercup', 'gone')).toBe(false);
  });
});
