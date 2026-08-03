/**
 * WI-7097: `withDbCallDeadline` — a caller-facing deadline for one DB round
 * trip, guarding against postgres.js silently retrying a failed INITIAL
 * connection attempt forever without ever rejecting the caller's pending
 * query (verified in node_modules/postgres/src/connection.js's `closed()`).
 *
 * Unlike connection-connect-timeout.test.ts (which asserts against source
 * because a real unreachable-host repro is inherently flaky/env-dependent),
 * `withDbCallDeadline` is a pure in-memory promise race with no I/O, so it is
 * exercised directly here with fake timers — deterministic, no real waiting.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  withDbCallDeadline,
  DbCallDeadlineError,
  DEFAULT_DB_CALL_DEADLINE_MS,
} from './connection';

describe('withDbCallDeadline (WI-7097)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the underlying value when it settles before the deadline', async () => {
    const p = Promise.resolve('ok');
    await expect(withDbCallDeadline(p, { label: 'test-call' })).resolves.toBe('ok');
  });

  it('propagates the underlying rejection when it settles before the deadline', async () => {
    const boom = new Error('real db error');
    const p = Promise.reject(boom);
    await expect(withDbCallDeadline(p, { label: 'test-call' })).rejects.toBe(boom);
  });

  it('rejects with DbCallDeadlineError when the promise never settles within ms', async () => {
    vi.useFakeTimers();
    // Simulates postgres.js's silent-retry-forever-on-failed-initial-connect:
    // a promise that never resolves or rejects.
    const neverSettles = new Promise<never>(() => {});
    const result = withDbCallDeadline(neverSettles, { ms: 1000, label: 'stuck-initial-connect' });
    // Attach a rejection handler immediately so vitest doesn't flag an
    // unhandled rejection while the fake timer is advanced below.
    const assertion = expect(result).rejects.toBeInstanceOf(DbCallDeadlineError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('DbCallDeadlineError carries the label, deadline, and elapsed time', async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise<never>(() => {});
    const result = withDbCallDeadline(neverSettles, { ms: 2500, label: 'my-label' });
    const assertion = result.catch((err: unknown) => err as DbCallDeadlineError);
    await vi.advanceTimersByTimeAsync(2500);
    const err = await assertion;
    expect(err).toBeInstanceOf(DbCallDeadlineError);
    expect(err.label).toBe('my-label');
    expect(err.deadlineMs).toBe(2500);
    expect(err.elapsedMs).toBeGreaterThanOrEqual(2500);
    expect(err.message).toContain('my-label');
    expect(err.message).toContain('WI-7097');
  });

  it('defaults ms to DEFAULT_DB_CALL_DEADLINE_MS when omitted', async () => {
    vi.useFakeTimers();
    const neverSettles = new Promise<never>(() => {});
    const result = withDbCallDeadline(neverSettles, { label: 'default-deadline' });
    const assertion = result.catch((err: unknown) => err as DbCallDeadlineError);
    await vi.advanceTimersByTimeAsync(DEFAULT_DB_CALL_DEADLINE_MS);
    const err = await assertion;
    expect(err.deadlineMs).toBe(DEFAULT_DB_CALL_DEADLINE_MS);
  });

  it('DEFAULT_DB_CALL_DEADLINE_MS is comfortably under a ~300s transport idle-timeout', () => {
    expect(DEFAULT_DB_CALL_DEADLINE_MS).toBeGreaterThan(0);
    expect(DEFAULT_DB_CALL_DEADLINE_MS).toBeLessThan(300_000);
  });

  it('does not fire the deadline once the underlying promise has already resolved (timer cleared)', async () => {
    vi.useFakeTimers();
    const p = Promise.resolve('fast');
    const result = withDbCallDeadline(p, { ms: 5000, label: 'fast-call' });
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe('fast');
    // Advancing well past the deadline after resolution must not throw /
    // leave a dangling unhandled rejection.
    await vi.advanceTimersByTimeAsync(10_000);
  });
});
