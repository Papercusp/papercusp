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
import { inspect } from 'node:util';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  withDbCallDeadline,
  withAcquisitionDeadline,
  DbCallDeadlineError,
  DEFAULT_DB_CALL_DEADLINE_MS,
  retryOnRetryableDbDeadline,
} from './connection';
import {
  beginAcquire,
  recordPoolMax,
  resetAcquireRegistryForTest,
  resetPgDiagnosticContextResolver,
  setPgDiagnosticContextResolver,
} from './acquire-registry';

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

describe('retryOnRetryableDbDeadline', () => {
  afterEach(() => {
    resetAcquireRegistryForTest();
  });

  it('retries a deadline only after decisive local pool-pressure evidence', async () => {
    recordPoolMax('org-app', 1);
    const held = beginAcquire('org-app');
    held.acquired();
    const waiting = beginAcquire('org-app');
    let attempts = 0;

    const result = await retryOnRetryableDbDeadline(
      async () => {
        attempts++;
        if (attempts === 1) throw new DbCallDeadlineError('principal-acquire', 45_000, 45_000, 'org-app');
        return 'ok';
      },
      { sleep: async () => undefined },
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    waiting.release();
    held.release();
  });

  it('does not retry an unmeasured deadline that could be a dead endpoint', async () => {
    let attempts = 0;
    const error = new DbCallDeadlineError('principal-acquire', 45_000, 45_000);

    await expect(
      retryOnRetryableDbDeadline(async () => {
        attempts++;
        throw error;
      }, { sleep: async () => undefined }),
    ).rejects.toBe(error);

    expect(attempts).toBe(1);
    expect(error.retryable).toBe(false);
  });
});

describe('withAcquisitionDeadline ticket diagnostics', () => {
  afterEach(() => {
    resetPgDiagnosticContextResolver();
    resetAcquireRegistryForTest();
    vi.useRealTimers();
  });

  it('captures the bounded active-ticket snapshot before releasing the timed-out ticket', async () => {
    vi.useFakeTimers();
    const requestId = 'e57ef6b3-46ef-4cc5-8214-fec83f2a463e';
    setPgDiagnosticContextResolver(() => ({
      processInstanceId: '11111111-1111-4111-8111-111111111111',
      buildSha: 'abcdef0',
      rowId: null,
      attemptId: '22222222-2222-4222-8222-222222222222',
      hopId: null,
      stage: null,
      boundary: null,
      requestId,
      operation: 'mcp.nativeSessionVerifier',
    }));
    function startPendingAcquisition() {
      return withAcquisitionDeadline(
        () => new Promise<never>(() => {}),
        { ms: 1_000, label: 'native-session-verifier', pool: 'org-admin' },
      );
    }
    const result = startPendingAcquisition();
    const assertion = result.catch(error => error as DbCallDeadlineError);

    await vi.advanceTimersByTimeAsync(1_000);
    const error = await assertion;

    expect(error.acquisitionTickets).toMatchObject({
      pool: 'org-admin',
      capacity: 8,
      active: 1,
      omitted: 0,
      tickets: [{
        state: 'waiting',
        requestId,
        operation: 'mcp.nativeSessionVerifier',
      }],
    });
    // This is how hono-host's fatal console.error renders the Error. Keeping
    // structured fields alone loses nested tickets to `[Object]`, and a stack
    // created by the timer alone cannot identify the acquisition's caller.
    const fatalLog = inspect(error);
    expect(fatalLog).toContain(requestId);
    expect(fatalLog).toContain('mcp.nativeSessionVerifier');
    expect(fatalLog).toContain('startPendingAcquisition');
  });

  it('aborts a pending acquisition promptly, marks it expired, and clears its deadline timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error('source budget expired');
    let phase: { disarm: () => void; expired: () => boolean } | undefined;
    const result = withAcquisitionDeadline(
      (current) => {
        phase = current;
        return new Promise<never>(() => {});
      },
      { ms: 10_000, label: 'session-turn-availability', signal: controller.signal },
    );
    const assertion = expect(result).rejects.toBe(reason);

    controller.abort(reason);
    await assertion;

    expect(phase?.expired()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it('does not start acquisition work for an already-aborted source signal', async () => {
    const controller = new AbortController();
    const reason = new Error('source already expired');
    controller.abort(reason);
    const run = vi.fn(async () => 'unreachable');

    await expect(withAcquisitionDeadline(run, {
      ms: 10_000,
      label: 'session-turn-availability',
      signal: controller.signal,
    })).rejects.toBe(reason);

    expect(run).not.toHaveBeenCalled();
  });
});
