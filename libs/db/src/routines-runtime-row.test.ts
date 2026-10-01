/**
 * routines-runtime-row.test.ts — WI-10005062.
 *
 * rowToRoutine passed `last_fired_at` through raw while normalizing `next_fire_at`. On the
 * operator connection that column is a string, so RoutineRow.lastFiredAt (typed Date|null)
 * was a string at runtime. routinesTick's claim-skip classifier then threw
 * `lastFiredAt.toISOString is not a function`, which aborted dispatch for every later due
 * routine in that tick.
 */
import { describe, expect, it } from 'vitest';

import { normalizeLastFiredAt, rowToRoutine } from './routines-runtime';

const baseRow = {
  id: 'rt_x',
  workspace_id: 'ws',
  install_slug: 'papercusp',
  name: 'x',
  trigger_kind: 'cron',
  trigger_config: { cron: '0 * * * * *' },
  target_role: 'system:x',
  payload_template: null,
  concurrency: 'skip',
  catchup: 'skip-old',
  tier: 'durable',
  active: true,
  next_fire_at: new Date('2026-10-01T19:00:00.000Z'),
  reschedule_interval_sec: null,
  target_owner_id: null,
};

describe('rowToRoutine lastFiredAt', () => {
  it('turns a string last_fired_at into a real Date', () => {
    const r = rowToRoutine({ ...baseRow, last_fired_at: '2026-10-01 19:08:25.42+00' });
    expect(r.lastFiredAt).toBeInstanceOf(Date);
    expect(r.lastFiredAt!.toISOString()).toBe('2026-10-01T19:08:25.420Z');
  });

  it('keeps a Date as-is and null as null', () => {
    const d = new Date('2026-10-01T19:08:25.420Z');
    expect(rowToRoutine({ ...baseRow, last_fired_at: d }).lastFiredAt).toBe(d);
    expect(rowToRoutine({ ...baseRow, last_fired_at: null }).lastFiredAt).toBeNull();
  });

  it('reads an unparseable value as null, never as a fabricated timestamp', () => {
    expect(normalizeLastFiredAt('not a time')).toBeNull();
    expect(normalizeLastFiredAt(undefined)).toBeNull();
  });
});
