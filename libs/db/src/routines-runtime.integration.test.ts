/**
 * routines-runtime — the substrate's cron routine ticker, proven against a REAL
 * Postgres (testcontainer; Docker required). Covers upsert (insert + ON CONFLICT
 * update), the due-query, the fire concurrency policies (queue/skip/cancel-prev),
 * and activate/delete.
 *
 * Run: cd libs/papercusp/libs/db && npx vitest run --config vitest.integration.config.ts src/routines-runtime.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import {
  listDueCronRoutines,
  listActiveEphemeralRoutines,
  recordEphemeralFire,
  fireRoutine,
  upsertRoutine,
  setRoutineActive,
  deleteRoutine,
  setRoutinesPerWorkspaceConflict,
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
            -- migration 408 (P-010/D-006): the durable|ephemeral execution-tier discriminator.
            tier text NOT NULL DEFAULT 'durable',
            next_fire_at timestamptz,
            last_fired_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            -- migration 323 (B-LOOP-1): the loop recurrence kind.
            reschedule_interval_sec integer,
            target_owner_id text,
            metadata jsonb,
            UNIQUE (install_slug, name),
            -- F-E1 migration 305: the composite unique the per-workspace ON CONFLICT targets.
            UNIQUE (workspace_id, install_slug, name)
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

  it('B-LOOP-1: round-trips the loop fields (reschedule_interval_sec + target_owner_id), incl. ON CONFLICT update', async () => {
    // A pure loop: no cron, an interval, a bound owner. Insert.
    const r = await upsertRoutine(
      sql,
      baseInput({ name: 'loopy', triggerConfig: {}, rescheduleIntervalSec: 90, targetOwnerId: 'su-abc' }),
      nextFn,
    );
    expect(r.rescheduleIntervalSec).toBe(90);
    expect(r.targetOwnerId).toBe('su-abc');
    // ON CONFLICT updates both.
    const updated = await upsertRoutine(
      sql,
      baseInput({ name: 'loopy', triggerConfig: {}, rescheduleIntervalSec: 120, targetOwnerId: 'su-def' }),
      nextFn,
    );
    expect(updated.rescheduleIntervalSec).toBe(120);
    expect(updated.targetOwnerId).toBe('su-def');
    // A non-loop routine reads both as null (default).
    const plain = await upsertRoutine(sql, baseInput({ name: 'plain' }), nextFn);
    expect(plain.rescheduleIntervalSec).toBeNull();
    expect(plain.targetOwnerId).toBeNull();
  });

  it('B-LOOP-1: a parked loop (next_fire_at=infinity) is NOT returned by listDueCronRoutines (skip-if-in-flight)', async () => {
    await upsertRoutine(sql, baseInput({ name: 'parked', triggerConfig: {}, rescheduleIntervalSec: 60 }), nextFn);
    // Simulate the claim parking it in-flight.
    await sql`UPDATE harness_shared.routines SET next_fire_at = 'infinity'::timestamptz WHERE name = 'parked'`;
    const due = await listDueCronRoutines(sql);
    expect(due.map((r) => r.name)).not.toContain('parked'); // infinity <= now() is false → not due
  });

  it("EI-6786: re-arming a CURRENTLY-PARKED loop (loop:arm mid-turn) does NOT un-park it — next_fire_at STAYS 'infinity', but reschedule_interval_sec still updates", async () => {
    await upsertRoutine(
      sql,
      baseInput({ name: 'rearm-parked', triggerConfig: {}, rescheduleIntervalSec: 270, targetOwnerId: 'su-abc' }),
      nextFn,
    );
    // Simulate the claim parking it in-flight (the state a loop is in for the WHOLE
    // duration of the very turn that would call loop:arm to widen its own cadence).
    await sql`UPDATE harness_shared.routines SET next_fire_at = 'infinity'::timestamptz WHERE name = 'rearm-parked'`;

    // Re-arm mid-turn: a fresh explicit nextFireAt (what materializeLoop always computes)
    // + a new interval — mirrors loop:arm { intervalSec: 900 } on an already-active loop.
    await upsertRoutine(
      sql,
      baseInput({
        name: 'rearm-parked',
        triggerConfig: {},
        rescheduleIntervalSec: 900,
        targetOwnerId: 'su-abc',
        nextFireAt: new Date(Date.now() + 900_000),
      }),
      nextFn,
    );

    const [row] = await sql<Array<{ still_parked: boolean; reschedule_interval_sec: number }>>`
      SELECT (next_fire_at = 'infinity'::timestamptz) AS still_parked, reschedule_interval_sec
      FROM harness_shared.routines WHERE name = 'rearm-parked'
    `;
    // Still parked — the completion-rebase (which keys on next_fire_at='infinity') will be
    // the one to re-arm it once the in-flight turn settles, off the FRESH interval below.
    expect(row!.still_parked).toBe(true);
    expect(row!.reschedule_interval_sec).toBe(900);
    // And it still correctly stays excluded from the due-set while parked.
    const due = await listDueCronRoutines(sql);
    expect(due.map((r) => r.name)).not.toContain('rearm-parked');
  });

  it('EI-6786 regression guard: a NON-parked routine (idle / not currently firing) still gets its next_fire_at updated normally on re-arm', async () => {
    const original = new Date(Date.now() + 60_000);
    await upsertRoutine(sql, baseInput({ name: 'idle-loop', triggerConfig: {}, nextFireAt: original }), nextFn);
    const rearmedAt = new Date(Date.now() + 900_000);
    const updated = await upsertRoutine(
      sql,
      baseInput({ name: 'idle-loop', triggerConfig: {}, nextFireAt: rearmedAt }),
      nextFn,
    );
    expect(updated.nextFireAt?.getTime()).toBe(rearmedAt.getTime());
  });

  it('EI-2019 cluster: per-workspace ON — a cross-workspace re-arm UPDATEs in place (idempotent), never flips workspace_id, never throws routines_pkey', async () => {
    setRoutinesPerWorkspaceConflict(true);
    try {
      await upsertRoutine(sql, baseInput({ workspaceId: 'ws-a' }), nextFn);
      // A re-arm of the SAME singleton (install_slug, name) resolved under a DIFFERENT
      // workspace_id — exactly how the live hive/overwatch declare-wake + watchdog fallback-arm
      // drift — must NOT collide on routines_pkey. It conflicts on the id PK and UPDATEs the
      // existing row in place. (Pre-fix this rejected with a duplicate-key throw, wedging every
      // later time wake — see EI-2019/EI-2082/EI-2123/EI-2000.)
      const updated = await upsertRoutine(sql, baseInput({ workspaceId: 'ws-b', targetRole: 'reviewer' }), nextFn);
      expect(updated.targetRole).toBe('reviewer'); // the re-arm landed (no throw)
      const rows = await sql<{ workspace_id: string }[]>`
        SELECT workspace_id FROM harness_shared.routines
         WHERE install_slug = 'papercup' AND name = 'nightly'`;
      // Exactly one row, workspace_id PRESERVED (not flipped to ws-b) — the anti-clobber intent
      // F-E1 wanted, now achieved by UPDATE-in-place instead of a fleet-wedging throw.
      expect(rows.map((r) => r.workspace_id)).toEqual(['ws-a']);
    } finally {
      setRoutinesPerWorkspaceConflict(false);
    }
  });

  it('EI-2019/EI-2082/EI-2123/EI-2000: re-arming a routine is idempotent (no routines_pkey duplicate-key) — flag ON or OFF, same- or cross-workspace', async () => {
    // The recurrence guard for the whole cluster: re-arming a singleton wake routine (the
    // hive/overwatch declare-wake + watchdog fallback-arm paths all funnel through here) must
    // converge to ONE row and never throw a duplicate-key, regardless of the per-workspace flag
    // or which workspace the re-arm resolves under (incl. a dropped-response partial commit
    // that already created the row).
    for (const flag of [false, true]) {
      setRoutinesPerWorkspaceConflict(flag);
      try {
        const name = `wake_${flag}`;
        // First arm (the singleton hive/overwatch wake row).
        await upsertRoutine(sql, baseInput({ name, workspaceId: 'ws-a', nextFireAt: new Date(Date.now() + 5_000) }), nextFn);
        // Re-arm, same workspace (a normal declare-wake) — UPDATE, never throw.
        await expect(
          upsertRoutine(sql, baseInput({ name, workspaceId: 'ws-a', nextFireAt: new Date(Date.now() + 10_000) }), nextFn),
        ).resolves.toBeDefined();
        // Re-arm under a DRIFTED workspace (the live failure mode) — UPDATE, never throw.
        await expect(
          upsertRoutine(sql, baseInput({ name, workspaceId: 'ws-b', nextFireAt: new Date(Date.now() + 15_000) }), nextFn),
        ).resolves.toBeDefined();
        const n = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM harness_shared.routines WHERE name = ${name}`;
        expect(n[0].n).toBe(1); // idempotent — single row, never duplicated
      } finally {
        setRoutinesPerWorkspaceConflict(false);
      }
    }
  });

  it('F-E1 (flag OFF, default): upsert still conflicts on (install_slug, name) — byte-identical', async () => {
    // Belt-and-suspenders: with the flag OFF, a 2nd upsert of the same (slug,name) UPDATES in
    // place exactly as before (no per-workspace behavior leaks in when the flag is off).
    await upsertRoutine(sql, baseInput({ workspaceId: 'ws-a' }), nextFn);
    const updated = await upsertRoutine(sql, baseInput({ workspaceId: 'ws-a', targetRole: 'reviewer' }), nextFn);
    expect(updated.targetRole).toBe('reviewer');
    const all = await sql`SELECT count(*)::int AS n FROM harness_shared.routines`;
    expect(all[0].n).toBe(1);
  });
});

describe('listDueCronRoutines', () => {
  it('retains an action admission clock after its served row leaves the due population', async () => {
    const recent = new Date(Date.now() - 1_000);
    const old = new Date(Date.now() - 60_000);
    await upsertRoutine(sql, baseInput({ name: 'backlog', nextFireAt: old }), nextFn);
    await upsertRoutine(sql, baseInput({ name: 'served', nextFireAt: new Date(Date.now() + 60_000) }), nextFn);
    await upsertRoutine(sql, baseInput({ name: 'inactive', active: false, nextFireAt: old }), nextFn);
    await sql`UPDATE harness_shared.routines SET last_fired_at = ${recent} WHERE name = 'served'`;
    await sql`UPDATE harness_shared.routines SET last_fired_at = now() WHERE name = 'inactive'`;
    const due = await listDueCronRoutines(sql);
    expect(due.map(row => row.name)).toEqual(['backlog']);
    expect(due[0].actionLastFiredAt).toEqual(recent);
  });

  it('returns active cron routines that are due, excluding inactive/non-cron/future', async () => {
    await upsertRoutine(sql, baseInput({ name: 'due', nextFireAt: new Date(Date.now() - 1000) }), nextFn);
    await upsertRoutine(sql, baseInput({ name: 'future', nextFireAt: new Date(Date.now() + 60_000) }), nextFn);
    await upsertRoutine(sql, baseInput({ name: 'inactive', active: false, nextFireAt: new Date(Date.now() - 1000) }), nextFn);
    await upsertRoutine(sql, baseInput({ name: 'webhook', triggerKind: 'webhook', triggerConfig: { webhook_token: 't' } }), nextFn);

    const due = await listDueCronRoutines(sql);
    expect(due.map((r) => r.name)).toEqual(['due']);
  });

  it('EXCLUDES ephemeral-tier routines — the tick is durable-only (P-011 / D-006)', async () => {
    await upsertRoutine(sql, baseInput({ name: 'durable-due', nextFireAt: new Date(Date.now() - 1000) }), nextFn);
    // An ephemeral routine: tier='ephemeral', interval_sec cadence, NO cron, next_fire_at NULL.
    // It is active + trigger_kind='cron' + due-by-null-next_fire_at, so WITHOUT the tier filter it
    // would be returned — the durable-only filter is what keeps the DBOS tick from firing it (the
    // per-host ephemeral executor owns it instead).
    await sql`
      INSERT INTO harness_shared.routines
        (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, tier, active, next_fire_at)
      VALUES ('rt_eph', ${WS}, 'papercup', 'eph-sweep', 'cron', '{"interval_sec":5}'::jsonb, 'system:foo', 'ephemeral', TRUE, NULL)
    `;
    const due = await listDueCronRoutines(sql);
    expect(due.map((r) => r.name)).toEqual(['durable-due']);
    expect(due.every((r) => r.tier === 'durable')).toBe(true);
  });
});

describe('listActiveEphemeralRoutines + recordEphemeralFire (P-012 / D-006)', () => {
  const insertEphemeral = (id: string, active: boolean): Promise<unknown> =>
    sql`INSERT INTO harness_shared.routines
          (id, workspace_id, install_slug, name, trigger_kind, trigger_config, target_role, tier, active)
        VALUES (${id}, ${WS}, 'papercup', ${id}, 'cron', '{"interval_sec":5}'::jsonb, 'system:foo', 'ephemeral', ${active})`;

  it('lists ONLY active ephemeral routines (excludes durable + inactive-ephemeral)', async () => {
    await upsertRoutine(sql, baseInput({ name: 'durable-x' }), nextFn); // tier defaults durable
    await insertEphemeral('eph-active', true);
    await insertEphemeral('eph-dark', false);
    const eph = await listActiveEphemeralRoutines(sql);
    expect(eph.map((r) => r.id)).toEqual(['eph-active']);
    expect(eph[0].tier).toBe('ephemeral');
    expect(eph[0].triggerConfig.interval_sec).toBe(5);
  });

  it('recordEphemeralFire stamps last_fired_at + sets/clears metadata.last_error in ONE row (never insert per fire — D-004)', async () => {
    await insertEphemeral('eph1', true);
    const before = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.routines`)[0].n;

    await recordEphemeralFire(sql, 'eph1', 'kaboom');
    let row = (await sql<Array<{ last_fired_at: Date | null; metadata: Record<string, unknown> }>>`
      SELECT last_fired_at, metadata FROM harness_shared.routines WHERE id = 'eph1'`)[0];
    expect(row.last_fired_at).not.toBeNull();
    expect(row.metadata.last_error).toBe('kaboom');

    await recordEphemeralFire(sql, 'eph1', null); // success clears the error
    row = (await sql<Array<{ last_fired_at: Date | null; metadata: Record<string, unknown> }>>`
      SELECT last_fired_at, metadata FROM harness_shared.routines WHERE id = 'eph1'`)[0];
    expect(row.metadata.last_error).toBeNull();

    const after = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.routines`)[0].n;
    expect(after).toBe(before); // two fires, zero new rows
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

  it('skip: serializes independent callers so only one event wins the read/insert race', async () => {
    const a = postgres(db.url, { max: 1, onnotice: () => {} });
    const b = postgres(db.url, { max: 1, onnotice: () => {} });
    try {
      const r = await upsertRoutine(sql, baseInput({ name: 'skip-race', concurrency: 'skip', nextFireAt: new Date(Date.now() - 1) }), nextFn);
      const [first, second] = await Promise.all([fireRoutine(a, r, nextFn), fireRoutine(b, r, nextFn)]);

      expect([first, second].filter((result) => result !== null)).toHaveLength(1);
      expect(await listUnconsumedEvents(sql, 'papercup')).toHaveLength(1);
    } finally {
      await Promise.all([a.end({ timeout: 5 }), b.end({ timeout: 5 })]);
    }
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
