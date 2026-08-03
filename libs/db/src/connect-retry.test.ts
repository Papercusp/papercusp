/**
 * connect-retry — unit tests (no DB needed; pure retry-loop logic).
 * EI-9279.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConnectPhaseDeadlineError,
  DEFAULT_CONNECT_PHASE_DEADLINE_MS,
  isRetriableConnectionSetupError,
  resolveConnectPhaseDeadlineMs,
  retryBeforeCallbackStarts,
} from './connect-retry';

describe('isRetriableConnectionSetupError', () => {
  it('matches a CONNECTION_CLOSED code', () => {
    expect(isRetriableConnectionSetupError({ code: 'CONNECTION_CLOSED' })).toBe(true);
  });

  it('matches a CONNECT_TIMEOUT code', () => {
    expect(isRetriableConnectionSetupError({ code: 'CONNECT_TIMEOUT' })).toBe(true);
  });

  it('matches on message when code is absent (postgres-js message fallback)', () => {
    expect(
      isRetriableConnectionSetupError({ message: 'write CONNECTION_CLOSED 127.0.0.1:6432' }),
    ).toBe(true);
  });

  it('does not match an unrelated error', () => {
    expect(isRetriableConnectionSetupError({ code: '23505', message: 'duplicate key' })).toBe(false);
  });

  it('does not match null/undefined', () => {
    expect(isRetriableConnectionSetupError(null)).toBe(false);
    expect(isRetriableConnectionSetupError(undefined)).toBe(false);
  });
});

describe('retryBeforeCallbackStarts', () => {
  const noSleep = () => Promise.resolve();

  it('returns the result on first-try success', async () => {
    const out = await retryBeforeCallbackStarts(async (markStarted) => {
      markStarted();
      return 42;
    });
    expect(out).toBe(42);
  });

  it('retries a CONNECTION_CLOSED thrown BEFORE markStarted(), then succeeds', async () => {
    let attempts = 0;
    const onRetry = vi.fn();
    const out = await retryBeforeCallbackStarts(
      async (markStarted) => {
        attempts++;
        if (attempts < 3) {
          // Fails before the caller's own work starts — safe to retry.
          throw { code: 'CONNECTION_CLOSED', message: 'write CONNECTION_CLOSED 127.0.0.1:6432' };
        }
        markStarted();
        return 'ok';
      },
      { sleep: noSleep, onRetry },
    );
    expect(out).toBe('ok');
    expect(attempts).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('NEVER retries once markStarted() has fired, even on a retriable-looking error', async () => {
    let attempts = 0;
    await expect(
      retryBeforeCallbackStarts(
        async (markStarted) => {
          attempts++;
          markStarted();
          // Simulate a connection blip AFTER the caller's own query began —
          // must propagate untouched, never re-run (could double-apply a write).
          throw { code: 'CONNECTION_CLOSED', message: 'write CONNECTION_CLOSED 127.0.0.1:6432' };
        },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
    expect(attempts).toBe(1);
  });

  it('does not retry a non-classified error, even before markStarted()', async () => {
    let attempts = 0;
    await expect(
      retryBeforeCallbackStarts(
        async () => {
          attempts++;
          throw new Error('boom: unrelated failure');
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow('boom: unrelated failure');
    expect(attempts).toBe(1);
  });

  it('gives up after `retries` attempts and rethrows the last error', async () => {
    let attempts = 0;
    await expect(
      retryBeforeCallbackStarts(
        async () => {
          attempts++;
          throw { code: 'CONNECTION_CLOSED' };
        },
        { sleep: noSleep, retries: 2 },
      ),
    ).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' });
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it('backs off with the configured sleep between retries', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    await retryBeforeCallbackStarts(
      async (markStarted) => {
        attempts++;
        if (attempts < 2) throw { code: 'CONNECT_TIMEOUT' };
        markStarted();
        return 'done';
      },
      {
        backoffMs: 150,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(sleeps).toEqual([150]); // backoffMs * attempt(1)
  });
});

/**
 * EI-19415414498429866 — the connect-phase deadline.
 *
 * Regression guard for a 29-minute fleet-wide MCP outage: `connect_timeout` is unset
 * in production, so a connect against a DEAD endpoint neither resolves nor rejects.
 * Because `dispatch()` wraps every tool handler in `withWorkspace` (which routes here),
 * that hung 100% of MCP dispatch until the process was restarted.
 *
 * The invariant these tests pin: the CONNECT phase is bounded, the caller's own work
 * is NOT.
 */
describe('retryBeforeCallbackStarts — connect-phase deadline', () => {
  it('rejects when the connect phase never settles (the dead-endpoint case)', async () => {
    vi.useFakeTimers();
    try {
      // Never calls markStarted() and never settles — exactly what postgres-js does
      // against a dead port with connect_timeout unset.
      const p = retryBeforeCallbackStarts(() => new Promise<string>(() => {}), {
        connectDeadlineMs: 45_000,
      });
      const assertion = expect(p).rejects.toThrow(ConnectPhaseDeadlineError);
      await vi.advanceTimersByTimeAsync(45_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT bound work once markStarted() has fired (a legitimately long tool)', async () => {
    vi.useFakeTimers();
    try {
      // Connection obtained immediately; the caller's own work then runs far longer
      // than the deadline. testing:run / code:run must never be cut off by this guard.
      const p = retryBeforeCallbackStarts(
        (markStarted) =>
          new Promise<string>((resolve) => {
            markStarted();
            setTimeout(() => resolve('slow-but-legitimate'), 600_000);
          }),
        { connectDeadlineMs: 45_000 },
      );
      await vi.advanceTimersByTimeAsync(600_001);
      await expect(p).resolves.toBe('slow-but-legitimate');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT retry a deadline breach — one dead endpoint costs ONE deadline', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const p = retryBeforeCallbackStarts(
        () => {
          attempts += 1;
          return new Promise<string>(() => {});
        },
        { connectDeadlineMs: 1_000, retries: 2, sleep: async () => {} },
      );
      const assertion = expect(p).rejects.toThrow(ConnectPhaseDeadlineError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      // retries:2 would mean 3 attempts (~3 deadlines) if a breach were retriable.
      expect(attempts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('connectDeadlineMs: 0 restores the unbounded wait', async () => {
    vi.useFakeTimers();
    try {
      let settle: ((v: string) => void) | undefined;
      const p = retryBeforeCallbackStarts(
        (markStarted) =>
          new Promise<string>((resolve) => {
            settle = (v) => {
              markStarted();
              resolve(v);
            };
          }),
        { connectDeadlineMs: 0 },
      );
      // Well past the default ceiling — with the bound disabled nothing fires.
      await vi.advanceTimersByTimeAsync(120_000);
      settle!('eventually');
      await expect(p).resolves.toBe('eventually');
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies a deadline breach as NOT retriable', () => {
    expect(isRetriableConnectionSetupError(new ConnectPhaseDeadlineError(45_000))).toBe(false);
  });

  it('a non-numeric env override does not silently disable the guard', () => {
    const prev = process.env.PAPERCUSP_DB_CONNECT_PHASE_DEADLINE_MS;
    try {
      process.env.PAPERCUSP_DB_CONNECT_PHASE_DEADLINE_MS = 'not-a-number';
      expect(resolveConnectPhaseDeadlineMs()).toBe(DEFAULT_CONNECT_PHASE_DEADLINE_MS);
      process.env.PAPERCUSP_DB_CONNECT_PHASE_DEADLINE_MS = '0';
      expect(resolveConnectPhaseDeadlineMs()).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_DB_CONNECT_PHASE_DEADLINE_MS;
      else process.env.PAPERCUSP_DB_CONNECT_PHASE_DEADLINE_MS = prev;
    }
  });
});
