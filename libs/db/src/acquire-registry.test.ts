/**
 * acquire-registry — unit tests (no DB; pure in-memory counters).
 * EI-19485014132257783 / EI-19448641861408544.
 *
 * The property under test is not "the counters increment". It is that the
 * SENTENCE the counters produce is only ever as strong as the measurement
 * behind it — which is the failure this module exists to end. Two rewrites of
 * the deadline errors (EI-19448665862739845, WI-8848) were needed because each
 * one asserted more than it had measured, so the verdict branches are pinned
 * here in both directions: what the numbers RULE OUT, and what they explicitly
 * do not cover.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  ACQUIRE_RECENT_SUCCESS_MS,
  acquireSnapshot,
  beginAcquire,
  describeAcquirePressure,
  recordPoolMax,
  resetAcquireRegistryForTest,
} from './acquire-registry';
import { withAcquisitionDeadline, DbCallDeadlineError } from './connection';

beforeEach(() => {
  resetAcquireRegistryForTest();
});

afterEach(() => {
  vi.useRealTimers();
  resetAcquireRegistryForTest();
});

describe('acquireSnapshot', () => {
  it('reports an unmeasured pool as max:null, NOT as an idle pool', () => {
    const s = acquireSnapshot('never-built');
    expect(s.max).toBeNull();
    expect(s.waiting).toBe(0);
    expect(s.held).toBe(0);
    expect(s.totalAcquired).toBe(0);
    expect(s.lastAcquiredAgoMs).toBeNull();
  });

  it('counts a waiter from the moment the ticket opens', () => {
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    const s = acquireSnapshot('org-app');
    expect(s.waiting).toBe(1);
    expect(s.held).toBe(0);
    expect(s.oldestWaitMs).toBeGreaterThanOrEqual(0);
    expect(s.max).toBe(20);
    t.release();
  });

  it('moves waiting -> held on acquired(), and records the success', () => {
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    t.acquired();
    const s = acquireSnapshot('org-app');
    expect(s.waiting).toBe(0);
    expect(s.held).toBe(1);
    expect(s.totalAcquired).toBe(1);
    expect(s.lastAcquiredAgoMs).toBeGreaterThanOrEqual(0);
    t.release();
    expect(acquireSnapshot('org-app').held).toBe(0);
  });

  it('release() is idempotent and never drives a count negative', () => {
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    t.acquired();
    t.release();
    t.release();
    t.acquired(); // after release, a late acquired() must not resurrect the ticket
    const s = acquireSnapshot('org-app');
    expect(s.waiting).toBe(0);
    expect(s.held).toBe(0);
    expect(s.totalAcquired).toBe(1);
  });

  it('releasing a ticket that never acquired drops the waiter (no leak)', () => {
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    expect(acquireSnapshot('org-app').waiting).toBe(1);
    t.release();
    expect(acquireSnapshot('org-app').waiting).toBe(0);
    expect(acquireSnapshot('org-app').totalAcquired).toBe(0);
  });

  it('keeps pools independent — one saturated pool never reads onto another', () => {
    recordPoolMax('org-app', 2);
    recordPoolMax('org-admin', 8);
    const a = beginAcquire('org-app');
    a.acquired();
    expect(acquireSnapshot('org-app').held).toBe(1);
    expect(acquireSnapshot('org-admin').held).toBe(0);
    a.release();
  });
});

describe('describeAcquirePressure — the verdict is bounded by the measurement', () => {
  it('returns null when nothing was measured, so the caller falls back instead of printing zeroes', () => {
    expect(describeAcquirePressure('never-built')).toBeNull();
  });

  it('NEVER-acquired reads as consistent-with-dead-endpoint, not as proof of one', () => {
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    const msg = describeAcquirePressure('org-app')!.text;
    expect(msg).toMatch(/NEVER obtained a connection in this process/i);
    // The pooler-queue alternative must survive: this is the branch where an
    // over-confident "the endpoint is dead" would send the reader to a dead end.
    expect(msg).toMatch(/pooler queue/i);
    expect(msg).not.toMatch(/RULED OUT/);
    t.release();
  });

  it('a RECENT success RULES OUT the dead-endpoint cause', () => {
    recordPoolMax('org-app', 20);
    const held = beginAcquire('org-app');
    held.acquired();
    const waiter = beginAcquire('org-app');
    const msg = describeAcquirePressure('org-app')!.text;
    expect(msg).toMatch(/RULED OUT/);
    expect(msg).toMatch(/queued, not disconnected/i);
    held.release();
    waiter.release();
  });

  it('held >= max CONFIRMS client saturation and says the server is irrelevant', () => {
    recordPoolMax('org-app', 2);
    const a = beginAcquire('org-app');
    const b = beginAcquire('org-app');
    a.acquired();
    b.acquired();
    const waiter = beginAcquire('org-app');
    const msg = describeAcquirePressure('org-app')!.text;
    expect(msg).toMatch(/CONFIRMED/);
    expect(msg).toMatch(/PAPERCUSP_DB_POOL_MAX/);
    // WI-8848's lesson, kept measurable: a healthy server is the EXPECTED reading here.
    expect(msg).toMatch(/server's spare capacity is irrelevant/i);
    a.release();
    b.release();
    waiter.release();
  });

  it('held < max must NOT be reported as free slots — the count is a LOWER BOUND', () => {
    recordPoolMax('org-app', 20);
    const a = beginAcquire('org-app');
    a.acquired();
    const msg = describeAcquirePressure('org-app')!.text;
    expect(msg).toMatch(/LOWER BOUND/);
    expect(msg).toMatch(/does NOT\s+mean free slots/i);
    expect(msg).not.toMatch(/CONFIRMED/);
    a.release();
  });

  it('always states that a sibling process has its own pool (the measured mechanism)', () => {
    // EI-19448641861408544: ~15 vitest workers each open their own
    // pcusp:org-app:p<pid> pool. A per-process registry that read as fleet-wide
    // would recreate exactly the over-claim this module exists to prevent.
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    t.acquired();
    const msg = describeAcquirePressure('org-app')!.text;
    expect(msg).toMatch(/THIS process/);
    expect(msg).toMatch(/vitest worker/i);
    t.release();
  });

  it('a STALE success stops ruling the endpoint out', () => {
    vi.useFakeTimers();
    recordPoolMax('org-app', 20);
    const first = beginAcquire('org-app');
    first.acquired();
    first.release();
    vi.advanceTimersByTime(ACQUIRE_RECENT_SUCCESS_MS + 1_000);
    const waiter = beginAcquire('org-app');
    const msg = describeAcquirePressure('org-app')!.text;
    expect(msg).not.toMatch(/RULED OUT/);
    expect(msg).toMatch(/DID work earlier/i);
    expect(msg).toMatch(/memoized for the process lifetime/i);
    waiter.release();
  });

  it('reports the oldest waiter, not the newest', () => {
    vi.useFakeTimers();
    recordPoolMax('org-app', 20);
    const old = beginAcquire('org-app');
    vi.advanceTimersByTime(30_000);
    const fresh = beginAcquire('org-app');
    expect(acquireSnapshot('org-app').oldestWaitMs).toBe(30_000);
    expect(describeAcquirePressure('org-app')!.text).toContain('oldest 30.0s');
    old.release();
    fresh.release();
  });
});

/**
 * The verdict decides how much PROCEDURE the error still needs to print.
 *
 * This is the actual deliverable: the old message handed the reader a 3-step
 * manual probe. Measuring is only half the fix — if the answer is then buried
 * under the same procedure it replaces, the reader is no better off. So a
 * DECISIVE verdict must swap the cause-fork for the short residual, and a
 * non-decisive one must keep the full fork intact.
 */
describe('verdict → how much procedure survives', () => {
  it('marks a ruled-out-endpoint verdict decisive', () => {
    recordPoolMax('org-app', 20);
    const held = beginAcquire('org-app');
    held.acquired();
    const r = describeAcquirePressure('org-app')!;
    expect(r.verdict).toBe('queued');
    expect(r.decisive).toBe(true);
    held.release();
  });

  it('marks saturation decisive and distinguishes it from a plain queue', () => {
    recordPoolMax('org-app', 1);
    const a = beginAcquire('org-app');
    a.acquired();
    const r = describeAcquirePressure('org-app')!;
    expect(r.verdict).toBe('client-saturation');
    expect(r.decisive).toBe(true);
    a.release();
  });

  it('leaves never-acquired and stale-success NON-decisive — the fork is still open', () => {
    vi.useFakeTimers();
    recordPoolMax('org-app', 20);
    const t = beginAcquire('org-app');
    const never = describeAcquirePressure('org-app')!;
    expect(never.verdict).toBe('never-acquired');
    expect(never.decisive).toBe(false);

    t.acquired();
    t.release();
    vi.advanceTimersByTime(ACQUIRE_RECENT_SUCCESS_MS + 1);
    const stale = describeAcquirePressure('org-app')!;
    expect(stale.verdict).toBe('stale-success');
    expect(stale.decisive).toBe(false);
  });
});

/**
 * The seam integration: `withAcquisitionDeadline` is the ONE place an
 * acquisition is registered, so a breach must carry the numbers and every exit
 * path must release. A leaked waiter would inflate every later snapshot, making
 * this diagnostic worse than none.
 */
describe('withAcquisitionDeadline — registry wiring', () => {
  it('a breach reports the waiter that breached, counting ITSELF', async () => {
    vi.useFakeTimers();
    recordPoolMax('org-app', 20);
    const p = withAcquisitionDeadline<string>(() => new Promise<string>(() => {}), {
      label: 'withWorkspace:acquire(app)',
      pool: 'org-app',
      ms: 45_000,
    });
    const caught = p.then(
      () => {
        throw new Error('expected a deadline rejection');
      },
      (e: unknown) => e as DbCallDeadlineError,
    );
    await vi.advanceTimersByTimeAsync(45_001);
    const err = await caught;
    expect(err).toBeInstanceOf(DbCallDeadlineError);
    expect(err.pool).toBe('org-app');
    expect(err.measured).toMatch(/1 acquisition\(s\) WAITING/);
    expect(err.message).toMatch(/MEASURED IN THIS PROCESS/);
    // The numbers must LEAD — the whole complaint was that the prose came first.
    expect(err.message.indexOf('MEASURED IN THIS PROCESS')).toBeLessThan(
      err.message.indexOf('Two causes present identically'),
    );
  });

  it('releases the ticket on the breach path', async () => {
    vi.useFakeTimers();
    recordPoolMax('org-app', 20);
    const p = withAcquisitionDeadline<string>(() => new Promise<string>(() => {}), {
      label: 'withWorkspace:acquire(app)',
      pool: 'org-app',
      ms: 1_000,
    });
    const caught = p.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1_001);
    await caught;
    expect(acquireSnapshot('org-app').waiting).toBe(0);
    expect(acquireSnapshot('org-app').held).toBe(0);
  });

  it('disarm() moves the ticket to held, and the finally releases it on success', async () => {
    recordPoolMax('org-app', 20);
    let heldDuringWork = -1;
    const out = await withAcquisitionDeadline<string>(
      async ({ disarm }) => {
        disarm();
        heldDuringWork = acquireSnapshot('org-app').held;
        return 'ok';
      },
      { label: 'withWorkspace:acquire(app)', pool: 'org-app' },
    );
    expect(out).toBe('ok');
    expect(heldDuringWork).toBe(1);
    expect(acquireSnapshot('org-app').held).toBe(0);
    expect(acquireSnapshot('org-app').totalAcquired).toBe(1);
  });

  it('releases the ticket when the caller’s own work THROWS', async () => {
    recordPoolMax('org-app', 20);
    await expect(
      withAcquisitionDeadline<string>(
        async ({ disarm }) => {
          disarm();
          throw new Error('caller blew up');
        },
        { label: 'withWorkspace:acquire(app)', pool: 'org-app' },
      ),
    ).rejects.toThrow('caller blew up');
    expect(acquireSnapshot('org-app').held).toBe(0);
    expect(acquireSnapshot('org-app').waiting).toBe(0);
  });

  it('omitting `pool` keeps the guard working and registers nothing', async () => {
    vi.useFakeTimers();
    const p = withAcquisitionDeadline<string>(() => new Promise<string>(() => {}), {
      label: 'unlabelled',
      ms: 1_000,
    });
    const caught = p.then(
      () => {
        throw new Error('expected a deadline rejection');
      },
      (e: unknown) => e as DbCallDeadlineError,
    );
    await vi.advanceTimersByTimeAsync(1_001);
    const err = await caught;
    expect(err).toBeInstanceOf(DbCallDeadlineError);
    expect(err.pool).toBeNull();
    expect(err.measured).toBeNull();
    expect(err.message).toMatch(/No acquire measurements were available/);
  });
});
